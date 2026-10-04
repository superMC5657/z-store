use super::InstallOutcome;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

/// 便携 ZIP 解压安装体（原 executor.rs PortableZip 分支纯移动，跨平台）。
pub fn install_portable_zip(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    let _ = std::fs::create_dir_all(&app_dir);

    let file = File::open(installer_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "打开 ZIP 归档失败 (文件: {}): {}。仅支持 .zip 格式，不支持 .7z",
            installer_path.display(),
            e
        )
    })?;

    let mut main_exe: Option<PathBuf> = None;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(path) => app_dir.join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            let _ = std::fs::create_dir_all(&outpath);
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    let _ = std::fs::create_dir_all(p);
                }
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;

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
) -> Result<Option<PathBuf>, String> {
    let mut main_exe: Option<PathBuf> = None;
    let entries = archive.entries().map_err(|e| e.to_string())?;
    for entry_res in entries {
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
            let _ = std::fs::create_dir_all(&outpath);
            continue;
        }
        if let Some(p) = outpath.parent() {
            if !p.exists() {
                let _ = std::fs::create_dir_all(p);
            }
        }
        let _mode = entry.header().mode().unwrap_or(0);
        let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        drop(outfile);

        #[cfg(unix)]
        {
            // 保留 tar 中的可执行位；缺 exec 位时兜底 0o755，保证 Linux 二进制可直接执行。
            use std::os::unix::fs::PermissionsExt;
            let perm_bits = if _mode & 0o111 != 0 && _mode & 0o777 != 0 {
                _mode & 0o777
            } else {
                0o755
            };
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
    let _ = std::fs::create_dir_all(&app_dir);

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
        unpack_tar_entries(&mut archive, &app_dir).map_err(|e| {
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
        unpack_tar_entries(&mut archive, &app_dir).map_err(|e| {
            format!(
                "解压 TAR.XZ 归档失败 (文件: {}): {}",
                installer_path.display(),
                e
            )
        })?
    } else if lower.ends_with(".tar") {
        let file = File::open(installer_path).map_err(|e| e.to_string())?;
        let mut archive = tar::Archive::new(file);
        unpack_tar_entries(&mut archive, &app_dir).map_err(|e| {
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

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}
