use super::InstallOutcome;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

/// 解压防护上限：累计未压缩字节与条目数，zip/tar 炸弹防磁盘耗尽。
/// 8 GiB 覆盖现存最大便携应用解压体积；条目 65536 远超正常发行包。
const MAX_EXTRACT_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_EXTRACT_ENTRIES: usize = 65_536;

/// 解压配额判定（纯函数）：条目数或累计字节数超限即报错，由调用方回滚后中止。
fn check_extract_quota(total_bytes: u64, add_bytes: u64, entries: usize) -> Result<(), String> {
    if entries > MAX_EXTRACT_ENTRIES {
        return Err(format!(
            "条目数 {} 超过上限 {}，疑似归档炸弹",
            entries, MAX_EXTRACT_ENTRIES
        ));
    }
    let projected = total_bytes.saturating_add(add_bytes);
    if projected > MAX_EXTRACT_TOTAL_BYTES {
        return Err(format!(
            "累计解压体积超过 {} 字节上限，疑似归档炸弹",
            MAX_EXTRACT_TOTAL_BYTES
        ));
    }
    Ok(())
}

/// 超限回滚：删除本次解压新建的文件，再按创建顺序的逆序删除本次新建的空目录
/// （`remove_dir` 仅删空目录，故 app_dir 既有内容与旧版本文件不受影响，可重试安装）。
fn rollback_extracted(written: &[PathBuf], created_dirs: &[PathBuf]) {
    for p in written {
        let _ = std::fs::remove_file(p);
    }
    for d in created_dirs.iter().rev() {
        let _ = std::fs::remove_dir(d);
    }
}

/// 创建 `dir` 及其缺失祖先，并按自顶向下顺序记录新建的目录（回滚逆序删除即最深层优先）。
fn create_dir_all_tracked(dir: &Path, created: &mut Vec<PathBuf>) -> io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    let mut missing = Vec::new();
    let mut cur = Some(dir);
    while let Some(p) = cur {
        if p.exists() {
            break;
        }
        missing.push(p.to_path_buf());
        cur = p.parent();
    }
    std::fs::create_dir_all(dir)?;
    missing.reverse();
    created.extend(missing);
    Ok(())
}

/// 便携 ZIP 解压安装体（原 executor.rs PortableZip 分支纯移动，跨平台）。
pub fn install_portable_zip(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    // 解压防护：跟踪本次新建的目录，回滚时连同目录一并清除。
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let _ = create_dir_all_tracked(&app_dir, &mut created_dirs);

    let file = File::open(installer_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "打开 ZIP 归档失败 (文件: {}): {}。仅支持 .zip 格式，不支持 .7z",
            installer_path.display(),
            e
        )
    })?;

    let mut main_exe: Option<PathBuf> = None;
    // 解压防护：跟踪本次新建文件 + 累计字节/条目配额，超限回滚并中止。
    let mut written: Vec<PathBuf> = Vec::new();
    let mut total_bytes: u64 = 0;
    let abort = |written: &[PathBuf], created_dirs: &[PathBuf], reason: &str| -> String {
        rollback_extracted(written, created_dirs);
        format!("解压中止：{}，已回滚本次解压内容", reason)
    };
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(path) => app_dir.join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            let _ = create_dir_all_tracked(&outpath, &mut created_dirs);
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    let _ = create_dir_all_tracked(p, &mut created_dirs);
                }
            }
            // 声明大小预检（提前拦下单文件超大声明）+ 实际写入复核（声明可谎报）
            if let Err(reason) = check_extract_quota(total_bytes, file.size(), i + 1) {
                return Err(abort(&written, &created_dirs, &reason));
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            let n = io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
            drop(outfile);
            written.push(outpath.clone());
            total_bytes += n;
            if let Err(reason) = check_extract_quota(total_bytes, 0, 0) {
                return Err(abort(&written, &created_dirs, &reason));
            }

            if outpath.extension().and_then(|ext| ext.to_str()) == Some("exe") && main_exe.is_none()
            {
                main_exe = Some(outpath);
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(ref exe) = main_exe {
        crate::installer::paths::create_desktop_shortcut(app_id, exe);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &main_exe;

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}

/// tar 条目路径防穿越拼接（对齐 zip `enclosed_name` 语义）：
/// 拒绝绝对路径 / Prefix / RootDir / 任何 `..`，仅拼接 Normal/CurDir。
fn enclosed_join(base: &Path, entry_path: &Path) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for comp in entry_path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => return None,
            Component::ParentDir => return None,
            Component::CurDir => {}
            Component::Normal(c) => out.push(c),
        }
    }
    Some(out)
}

fn unpack_tar_entries<R: io::Read>(
    archive: &mut tar::Archive<R>,
    app_dir: &Path,
    created_dirs: &mut Vec<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let mut main_exe: Option<PathBuf> = None;
    // 解压防护：与 zip 同一配额口径，超限回滚本次已写文件与新建目录并中止。
    let mut written: Vec<PathBuf> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut entries_seen: usize = 0;
    let abort = |written: &[PathBuf], created_dirs: &[PathBuf], reason: &str| -> String {
        rollback_extracted(written, created_dirs);
        format!("解压中止：{}，已回滚本次解压内容", reason)
    };
    let entries = archive.entries().map_err(|e| e.to_string())?;
    for entry_res in entries {
        entries_seen += 1;
        let mut entry = entry_res.map_err(|e| e.to_string())?;
        let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            continue;
        }
        // 穿越校验前置：绝对路径 / Prefix / RootDir / 任何 `..` 直接跳过。
        // 必须在剥顶层目录之前判定，否则 `../x` 剥掉首组件后将绕过检查。
        {
            let mut bad = false;
            for comp in entry_path.components() {
                match comp {
                    Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                        bad = true;
                        break;
                    }
                    Component::CurDir | Component::Normal(_) => {}
                }
            }
            if bad {
                continue;
            }
        }
        // 剥顶层目录（strip-first-component，与 zip 归一）：过滤 `CurDir` 后去掉首个组件；
        // 单组件目录即顶层本身，跳过；单组件文件说明归档无顶层目录，予以保留。
        let normals: Vec<std::ffi::OsString> = entry_path
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_os_string()),
                _ => None,
            })
            .collect();
        if normals.is_empty() {
            continue;
        }
        let rel: PathBuf = if normals.len() == 1 {
            if entry_type.is_dir() {
                continue;
            }
            PathBuf::from(&normals[0])
        } else {
            normals[1..].iter().collect()
        };
        let Some(outpath) = enclosed_join(app_dir, &rel) else {
            continue;
        };
        if entry_type.is_dir() {
            let _ = create_dir_all_tracked(&outpath, created_dirs);
            continue;
        }
        if let Some(p) = outpath.parent() {
            if !p.exists() {
                let _ = create_dir_all_tracked(p, created_dirs);
            }
        }
        // 声明大小预检 + 实际写入复核（与 zip 同口径）
        let declared = entry.header().size().unwrap_or(0);
        if let Err(reason) = check_extract_quota(total_bytes, declared, entries_seen) {
            return Err(abort(&written, created_dirs, &reason));
        }
        let _mode = entry.header().mode().unwrap_or(0);
        let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
        let n = io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        drop(outfile);
        written.push(outpath.clone());
        total_bytes += n;
        if let Err(reason) = check_extract_quota(total_bytes, 0, 0) {
            return Err(abort(&written, created_dirs, &reason));
        }

        #[cfg(unix)]
        {
            // 权限按可执行位二值判定：有任一 exec 位 → 0o755（二进制/脚本可直接执行），
            // 否则 0o644：无 exec 位的普通文件按普通数据落盘，不兜底成全员可执行，
            // 也不保留归档中的 setuid/setgid/sticky 等特权位。
            use std::os::unix::fs::PermissionsExt;
            let perm_bits = if _mode & 0o111 != 0 { 0o755 } else { 0o644 };
            let _ = std::fs::set_permissions(
                &outpath,
                std::fs::Permissions::from_mode(perm_bits),
            );
        }

        // 主程序嗅探与 zip 一致：首个 .exe 即视为主程序（Windows 快捷方式用）。
        if outpath.extension().and_then(|ext| ext.to_str()) == Some("exe")
            && main_exe.is_none()
        {
            main_exe = Some(outpath.clone());
        }
    }
    Ok(main_exe)
}

/// 便携 Tarball 解压安装体（跨平台；上层只会传入本平台命中的包）：
/// 支持 `.tar.gz/.tgz` (gzip)、`.tar.xz` (xz)、`.tar` (plain)；
/// `.tar.bz2` 暂不支持，返回明确错误（不引入 bzip2 依赖）。
pub fn install_portable_tarball(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let _ = create_dir_all_tracked(&app_dir, &mut created_dirs);

    let lower = installer_path
        .as_os_str()
        .to_string_lossy()
        .to_lowercase();

    if lower.ends_with(".tar.bz2") {
        return Err(format!(
            "暂不支持 .tar.bz2 解压 (文件: {})。请使用 .tar.gz/.tar.xz/.tar 分发包",
            installer_path.display()
        ));
    }

    let main_exe: Option<PathBuf> = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let file = File::open(installer_path).map_err(|e| e.to_string())?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        unpack_tar_entries(&mut archive, &app_dir, &mut created_dirs).map_err(|e| {
            format!(
                "解压 TAR.GZ 归档失败 (文件: {}): {}",
                installer_path.display(),
                e
            )
        })?
    } else if lower.ends_with(".tar.xz") {
        let file = File::open(installer_path).map_err(|e| e.to_string())?;
        let decoder = xz2::read::XzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        unpack_tar_entries(&mut archive, &app_dir, &mut created_dirs).map_err(|e| {
            format!(
                "解压 TAR.XZ 归档失败 (文件: {}): {}",
                installer_path.display(),
                e
            )
        })?
    } else if lower.ends_with(".tar") {
        let file = File::open(installer_path).map_err(|e| e.to_string())?;
        let mut archive = tar::Archive::new(file);
        unpack_tar_entries(&mut archive, &app_dir, &mut created_dirs).map_err(|e| {
            format!(
                "解压 TAR 归档失败 (文件: {}): {}",
                installer_path.display(),
                e
            )
        })?
    } else {
        return Err(format!(
            "未知 tarball 扩展名 (文件: {})。仅支持 .tar.gz/.tgz/.tar.xz/.tar",
            installer_path.display()
        ));
    };

    #[cfg(target_os = "windows")]
    if let Some(ref exe) = main_exe {
        crate::installer::paths::create_desktop_shortcut(app_id, exe);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &main_exe;

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}

#[cfg(test)]
mod extract_guard_tests {
    use super::*;

    #[test]
    fn quota_rejects_entry_overflow_and_byte_bomb() {
        assert!(check_extract_quota(0, 1024, 10).is_ok());
        assert!(check_extract_quota(MAX_EXTRACT_TOTAL_BYTES - 1, 1, 1).is_ok());
        assert!(check_extract_quota(0, 0, MAX_EXTRACT_ENTRIES + 1).is_err());
        assert!(check_extract_quota(MAX_EXTRACT_TOTAL_BYTES - 1, 2, 1).is_err());
        // u64 溢出饱和判定不 panic
        assert!(check_extract_quota(u64::MAX, 1, 1).is_err());
    }

    #[test]
    fn rollback_removes_only_tracked_files_and_created_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let keep = dir.path().join("keep.txt");
        let gone = dir.path().join("gone.txt");
        std::fs::write(&keep, b"k").unwrap();
        std::fs::write(&gone, b"g").unwrap();
        let mut created = Vec::new();
        let nested = dir.path().join("newdir").join("nested");
        create_dir_all_tracked(&nested, &mut created).unwrap();
        rollback_extracted(std::slice::from_ref(&gone), &created);
        assert!(keep.exists(), "untracked file must survive rollback");
        assert!(!gone.exists(), "tracked file must be removed");
        assert!(!nested.exists(), "created nested dir must be removed");
        assert!(
            !dir.path().join("newdir").exists(),
            "created parent dir must be removed deepest-first"
        );
        assert!(dir.path().exists(), "pre-existing base dir must survive");
    }

    #[test]
    fn rollback_keeps_pre_existing_directories() {
        let dir = tempfile::tempdir().unwrap();
        // 目录已存在（更新安装场景）：不得记录、不得在回滚时删除。
        let mut created = Vec::new();
        create_dir_all_tracked(dir.path(), &mut created).unwrap();
        assert!(created.is_empty(), "existing dir must not be tracked");
        rollback_extracted(&[], &created);
        assert!(dir.path().exists(), "pre-existing dir must survive rollback");
    }

    #[test]
    fn zip_install_extracts_entries_and_tracks_quota() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("app.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        zw.start_file("myapp/app.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut zw, b"fake-exe-bytes").unwrap();
        zw.start_file("myapp/data/readme.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut zw, b"hello").unwrap();
        zw.finish().unwrap();

        let base = tempfile::tempdir().unwrap();
        let res = super::install_portable_zip(
            &zip_path,
            "owner/repo",
            Some(base.path().to_str().unwrap()),
        );
        assert!(res.is_ok(), "normal zip must extract: {:?}", res.err());
        let app_dir = crate::installer::paths::dirs_or_fallback_with_base(
            "owner/repo",
            Some(base.path().to_str().unwrap()),
        );
        assert!(app_dir.join("myapp").join("app.exe").is_file());
        assert!(app_dir.join("myapp").join("data").join("readme.txt").is_file());
    }

    #[test]
    fn tar_install_extracts_entries_within_quota() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("app.tar");
        let f = std::fs::File::create(&tar_path).unwrap();
        {
            let mut tb = tar::Builder::new(f);
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            tb.append_data(&mut header, "myapp/data.txt", b"hello".as_ref())
                .unwrap();
            let mut header2 = tar::Header::new_gnu();
            header2.set_size(4);
            header2.set_mode(0o755);
            header2.set_cksum();
            tb.append_data(&mut header2, "myapp/bin/run", b"#!/x".as_ref())
                .unwrap();
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let res = super::install_portable_tarball(
            &tar_path,
            "owner/repo",
            Some(base.path().to_str().unwrap()),
        );
        assert!(res.is_ok(), "normal tar must extract: {:?}", res.err());
        let app_dir = crate::installer::paths::dirs_or_fallback_with_base(
            "owner/repo",
            Some(base.path().to_str().unwrap()),
        );
        // tar 通道剥顶层目录（与 zip 归一）：myapp/* 落在 app_dir 根。
        assert!(app_dir.join("data.txt").is_file());
        assert!(app_dir.join("bin").join("run").is_file());
    }
}
