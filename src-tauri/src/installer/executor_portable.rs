use super::InstallOutcome;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static STAGE_NONCE: AtomicU64 = AtomicU64::new(0);

/// 在目标目录同级构造唯一临时目录路径（同卷保障原子 `rename`）。
fn sibling_temp_dir(dest_dir: &Path, tag: &str) -> Result<PathBuf, String> {
    let parent = dest_dir
        .parent()
        .ok_or_else(|| format!("目标便携目录缺少父目录: {}", dest_dir.display()))?;
    let base_name = dest_dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("app");
    let nonce = STAGE_NONCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{}.zstore-{}-{}-{}",
        base_name,
        tag,
        std::process::id(),
        nonce
    )))
}

/// 暂存目录 RAII 守卫：未转正前任何错误返回或 panic 均自动清理，避免残留半成品目录。
struct StagingDirGuard(Option<PathBuf>);

impl StagingDirGuard {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    fn path(&self) -> &Path {
        self.0.as_deref().unwrap_or_else(|| Path::new(""))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            if p.exists() {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }
}

/// 同卷目录重命名（Windows 下短暂文件索引占用时有界重试）。
fn rename_dir_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut last_err: Option<io::Error> = None;
    for attempt in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = cfg!(target_os = "windows")
                    && (e.kind() == io::ErrorKind::PermissionDenied
                        || matches!(e.raw_os_error(), Some(5 | 32)));
                last_err = Some(e);
                if !transient || attempt == 4 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// 原子替换目录：
/// - 首次安装直接 `rename(source -> dest)`；
/// - 覆盖升级先 `rename(dest -> .bak)`，再 `rename(source -> dest)`，任一步失败立即恢复 `.bak`，
///   确保升级中断绝不破坏既有可用版本。
fn atomic_swap_dir_with<F>(
    source_dir: &Path,
    dest_dir: &Path,
    mut rename_fn: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    if !dest_dir.exists() {
        rename_fn(source_dir, dest_dir).map_err(|e| {
            format!(
                "提交解压目录失败 ({} -> {}): {}",
                source_dir.display(),
                dest_dir.display(),
                e
            )
        })?;
        return Ok(());
    }

    let backup_dir = sibling_temp_dir(dest_dir, "bak")?;
    rename_fn(dest_dir, &backup_dir).map_err(|e| {
        format!(
            "无法替换已存在的旧版本目录（可能应用正在运行或文件被占用）({}): {}",
            dest_dir.display(),
            e
        )
    })?;

    if let Err(swap_err) = rename_fn(source_dir, dest_dir) {
        return match rename_fn(&backup_dir, dest_dir) {
            Ok(()) => Err(format!(
                "切换新版本目录失败，已恢复旧版本 ({}): {}",
                dest_dir.display(),
                swap_err
            )),
            Err(restore_err) => Err(format!(
                "切换新版本目录失败 ({})，且恢复旧版本失败 ({})；旧版本备份保留在 {}",
                swap_err,
                restore_err,
                backup_dir.display()
            )),
        };
    }

    let _ = std::fs::remove_dir_all(&backup_dir);
    Ok(())
}

fn atomic_swap_dir(source_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    atomic_swap_dir_with(source_dir, dest_dir, rename_dir_with_retry)
}

/// 若暂存目录仅含唯一顶层真实目录（非软链、且无并列顶层文件/目录），返回该单根目录以便剥离；
/// 多根结构（如 `bin/`、`lib/`、`etc/`）或含顶层文件时返回 `None`，完整保留原目录结构。
fn single_top_level_dir(staging_dir: &Path) -> Option<PathBuf> {
    let mut entries = std::fs::read_dir(staging_dir).ok()?;
    let first = entries.next()?.ok()?.path();
    if entries.next().is_some() {
        return None;
    }
    let is_real_dir = std::fs::symlink_metadata(&first)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false);
    is_real_dir.then_some(first)
}

/// 便携版桌面快捷方式命名：优先应用展示名，缺失或空白时回退规范 `app_id`。
pub(crate) fn portable_shortcut_label<'a>(app_name: Option<&'a str>, app_id: &'a str) -> &'a str {
    match app_name {
        Some(name) if !name.trim().is_empty() => name,
        _ => app_id,
    }
}

/// 解压防护上限：累计未压缩字节与条目数，zip/tar 炸弹防磁盘耗尽。
/// 8 GiB 覆盖现存最大便携应用解压体积；条目 65536 远超正常发行包。
#[derive(Debug, Clone, Copy)]
struct ExtractLimits {
    max_total_bytes: u64,
    max_entries: usize,
}

const DEFAULT_EXTRACT_LIMITS: ExtractLimits = ExtractLimits {
    max_total_bytes: 8 * 1024 * 1024 * 1024,
    max_entries: 65_536,
};

/// 解压配额判定（纯函数）：条目数或累计字节数超限即报错，由调用方回滚后中止。
fn check_extract_quota(
    limits: ExtractLimits,
    total_bytes: u64,
    add_bytes: u64,
    entries: usize,
) -> Result<(), String> {
    if entries > limits.max_entries {
        return Err(format!(
            "条目数 {} 超过上限 {}，疑似归档炸弹",
            entries, limits.max_entries
        ));
    }
    let projected = total_bytes.saturating_add(add_bytes);
    if projected > limits.max_total_bytes {
        return Err(format!(
            "累计解压体积超过 {} 字节上限，疑似归档炸弹",
            limits.max_total_bytes
        ));
    }
    Ok(())
}

/// 回滚：删除本次解压新建的文件，再按创建顺序的逆序删除本次新建的空目录
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
/// 中途失败时已建出的那部分祖先同样记录，供回滚清除。
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
    missing.reverse();
    let res = std::fs::create_dir_all(dir);
    created.extend(missing.into_iter().filter(|p| p.is_dir()));
    res
}

/// 解压读写缓冲：归档源与落盘文件均经缓冲，减少小块系统调用。
const EXTRACT_IO_BUF: usize = 64 * 1024;

fn open_buffered(path: &Path) -> Result<io::BufReader<File>, String> {
    File::open(path)
        .map(|f| io::BufReader::with_capacity(EXTRACT_IO_BUF, f))
        .map_err(|e| e.to_string())
}

/// 按剩余配额截断拷贝：最多读取 `remaining + 1` 字节，读到第 `remaining + 1` 字节即判定超限。
/// 归档头声明大小可谎报，实际落盘字节必须在拷贝过程中硬限，而非写完再复核。
fn copy_capped<R: Read + ?Sized, W: Write>(
    reader: &mut R,
    writer: &mut W,
    remaining: u64,
    limits: ExtractLimits,
) -> Result<u64, String> {
    let mut capped = reader.take(remaining.saturating_add(1));
    let n = io::copy(&mut capped, writer).map_err(|e| format!("写入解压文件失败: {}", e))?;
    if n > remaining {
        return Err(format!(
            "实际解压体积超过 {} 字节上限（归档头声明大小不可信），疑似归档炸弹",
            limits.max_total_bytes
        ));
    }
    Ok(n)
}

/// 单次解压的落盘账本：本次新建的文件 / 目录、累计字节与条目数。
/// 解压体返回 `Err` 时由调用方统一 `rollback`，任何错误路径都不残留半成品。
struct ExtractTracker {
    limits: ExtractLimits,
    written: Vec<PathBuf>,
    created_dirs: Vec<PathBuf>,
    total_bytes: u64,
    entries: usize,
}

impl ExtractTracker {
    fn new(limits: ExtractLimits) -> Self {
        Self {
            limits,
            written: Vec::new(),
            created_dirs: Vec::new(),
            total_bytes: 0,
            entries: 0,
        }
    }

    /// 每个归档条目（含目录、软链、被跳过的条目）都计数，海量空条目同样受限。
    fn count_entry(&mut self) -> Result<(), String> {
        self.entries += 1;
        check_extract_quota(self.limits, self.total_bytes, 0, self.entries)
    }

    fn create_dir(&mut self, dir: &Path) -> Result<(), String> {
        create_dir_all_tracked(dir, &mut self.created_dirs)
            .map_err(|e| format!("创建目录失败 ({}): {}", dir.display(), e))
    }

    /// 写出一个常规文件：声明大小预检 → 建父目录 → 建文件（立即登记）→ 按剩余配额截断拷贝。
    fn write_file<R: Read + ?Sized>(
        &mut self,
        reader: &mut R,
        outpath: &Path,
        declared: u64,
    ) -> Result<(), String> {
        check_extract_quota(self.limits, self.total_bytes, declared, self.entries)?;
        if let Some(parent) = outpath.parent() {
            self.create_dir(parent)?;
        }
        let outfile = File::create(outpath)
            .map_err(|e| format!("创建文件失败 ({}): {}", outpath.display(), e))?;
        self.written.push(outpath.to_path_buf());
        let mut outfile = io::BufWriter::with_capacity(EXTRACT_IO_BUF, outfile);
        let remaining = self.limits.max_total_bytes.saturating_sub(self.total_bytes);
        let n = copy_capped(reader, &mut outfile, remaining, self.limits)?;
        outfile
            .flush()
            .map_err(|e| format!("写入解压文件失败: {}", e))?;
        self.total_bytes += n;
        Ok(())
    }

    fn rollback(&self) {
        rollback_extracted(&self.written, &self.created_dirs);
    }
}

fn abort_message(reason: &str) -> String {
    format!("解压中止：{}，已回滚本次解压内容", reason)
}

/// 主程序嗅探：首个 .exe 即视为主程序（Windows 快捷方式用）。
fn note_main_exe(main_exe: &mut Option<PathBuf>, outpath: &Path) {
    if main_exe.is_none() && outpath.extension().and_then(|ext| ext.to_str()) == Some("exe") {
        *main_exe = Some(outpath.to_path_buf());
    }
}

/// 便携 ZIP 解压安装体（跨平台；默认以 `app_id` 为快捷方式名）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn install_portable_zip(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    install_portable_zip_with_name(installer_path, app_id, None, custom_portable_dir)
}

/// 便携 ZIP 解压安装体（带展示名，供桌面快捷方式统一命名）。
pub fn install_portable_zip_with_name(
    installer_path: &Path,
    app_id: &str,
    app_name: Option<&str>,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    install_portable_zip_into(
        installer_path,
        portable_shortcut_label(app_name, app_id),
        &app_dir,
        DEFAULT_EXTRACT_LIMITS,
    )
}

fn install_portable_zip_into(
    installer_path: &Path,
    shortcut_label: &str,
    app_dir: &Path,
    limits: ExtractLimits,
) -> Result<InstallOutcome, String> {
    let file = open_buffered(installer_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "打开 ZIP 归档失败 (文件: {}): {}。仅支持 .zip 格式，不支持 .7z",
            installer_path.display(),
            e
        )
    })?;

    if let Some(parent) = app_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建便携父目录失败 ({}): {}", parent.display(), e))?;
    }
    let staging_path = sibling_temp_dir(app_dir, "stage")?;
    let mut staging_guard = StagingDirGuard::new(staging_path);
    let staging_dir = staging_guard.path().to_path_buf();

    let mut tracker = ExtractTracker::new(limits);
    let staged_main_exe = match unpack_zip_entries(&mut archive, &staging_dir, &mut tracker) {
        Ok(main_exe) => main_exe,
        Err(reason) => {
            tracker.rollback();
            return Err(abort_message(&reason));
        }
    };

    atomic_swap_dir(&staging_dir, app_dir)?;
    staging_guard.disarm();

    let main_exe = staged_main_exe.and_then(|p| {
        p.strip_prefix(&staging_dir)
            .ok()
            .map(|rel| app_dir.join(rel))
    });

    #[cfg(target_os = "windows")]
    if let Some(ref exe) = main_exe {
        crate::installer::paths::create_desktop_shortcut(shortcut_label, exe);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&main_exe, shortcut_label);

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}

fn unpack_zip_entries<R: Read + io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    app_dir: &Path,
    tracker: &mut ExtractTracker,
) -> Result<Option<PathBuf>, String> {
    tracker.create_dir(app_dir)?;
    let mut main_exe: Option<PathBuf> = None;
    for i in 0..archive.len() {
        tracker.count_entry()?;
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目 #{} 失败: {}", i, e))?;
        // 软链条目一律跳过：解出的链接可指向 app_dir 之外，后续写入将越界。
        if file.is_symlink() {
            continue;
        }
        let outpath = match file.enclosed_name() {
            Some(path) => app_dir.join(path),
            None => continue,
        };
        if file.is_dir() {
            tracker.create_dir(&outpath)?;
            continue;
        }
        let declared = file.size();
        tracker.write_file(&mut file, &outpath, declared)?;
        note_main_exe(&mut main_exe, &outpath);
    }
    Ok(main_exe)
}

/// 跨平台归档条目路径安全校验：拒绝绝对路径、Windows 盘符前缀及任意 `/` 或 `\` 分隔的 `..`。
fn is_unsafe_archive_path(entry_path: &Path) -> bool {
    if entry_path.components().any(|comp| {
        matches!(
            comp,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return true;
    }
    let raw = entry_path.to_string_lossy();
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    raw.split(['/', '\\']).any(|seg| seg == "..")
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

fn unpack_tar_entries<R: Read>(
    archive: &mut tar::Archive<R>,
    staging_dir: &Path,
    tracker: &mut ExtractTracker,
) -> Result<Option<PathBuf>, String> {
    tracker.create_dir(staging_dir)?;
    let mut main_exe: Option<PathBuf> = None;
    let entries = archive.entries().map_err(|e| e.to_string())?;
    for entry_res in entries {
        // 条目计数前置于一切过滤：目录 / 软链 / 硬链 / 穿越条目同样占配额。
        tracker.count_entry()?;
        let mut entry = entry_res.map_err(|e| e.to_string())?;
        let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            continue;
        }
        // 穿越校验前置：绝对路径 / Prefix / RootDir / 任何 `..` 直接跳过。
        if is_unsafe_archive_path(&entry_path) {
            continue;
        }
        // 完整保留归档内相对层级落入暂存目录；单顶层公共目录剥离推迟到全部解包完成后统一判定，
        // 避免无条件剥首段把 `bin/` + `lib/` + `etc/` 多根包拍扁冲突。
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
        let rel: PathBuf = normals.iter().collect();
        let Some(outpath) = enclosed_join(staging_dir, &rel) else {
            continue;
        };
        if entry_type.is_dir() {
            tracker.create_dir(&outpath)?;
            continue;
        }
        let declared = entry.header().size().unwrap_or(0);
        let _mode = entry.header().mode().unwrap_or(0);
        tracker.write_file(&mut entry, &outpath, declared)?;

        #[cfg(unix)]
        {
            // 权限按可执行位二值判定：有任一 exec 位 → 0o755（二进制/脚本可直接执行），
            // 否则 0o644：无 exec 位的普通文件按普通数据落盘，不兜底成全员可执行，
            // 也不保留归档中的 setuid/setgid/sticky 等特权位。
            use std::os::unix::fs::PermissionsExt;
            let perm_bits = if _mode & 0o111 != 0 { 0o755 } else { 0o644 };
            let _ = std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(perm_bits));
        }

        note_main_exe(&mut main_exe, &outpath);
    }
    Ok(main_exe)
}

/// 便携 Tarball 解压安装体（跨平台；默认以 `app_id` 为快捷方式名）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn install_portable_tarball(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    install_portable_tarball_with_name(installer_path, app_id, None, custom_portable_dir)
}

/// 便携 Tarball 解压安装体（跨平台；带展示名，供桌面快捷方式统一命名）：
/// 支持 `.tar.gz/.tgz` (gzip)、`.tar.xz` (xz)、`.tar` (plain)；
/// `.tar.bz2` 暂不支持，返回明确错误（不引入 bzip2 依赖）。
pub fn install_portable_tarball_with_name(
    installer_path: &Path,
    app_id: &str,
    app_name: Option<&str>,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    install_portable_tarball_into(
        installer_path,
        portable_shortcut_label(app_name, app_id),
        &app_dir,
        DEFAULT_EXTRACT_LIMITS,
    )
}

fn install_portable_tarball_into(
    installer_path: &Path,
    shortcut_label: &str,
    app_dir: &Path,
    limits: ExtractLimits,
) -> Result<InstallOutcome, String> {
    let lower = installer_path.as_os_str().to_string_lossy().to_lowercase();

    if lower.ends_with(".tar.bz2") {
        return Err(format!(
            "暂不支持 .tar.bz2 解压 (文件: {})。请使用 .tar.gz/.tar.xz/.tar 分发包",
            installer_path.display()
        ));
    }

    let (kind, reader): (&str, Box<dyn Read>) =
        if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            let file = open_buffered(installer_path)?;
            ("TAR.GZ", Box::new(flate2::read::GzDecoder::new(file)))
        } else if lower.ends_with(".tar.xz") {
            let file = open_buffered(installer_path)?;
            ("TAR.XZ", Box::new(xz2::read::XzDecoder::new(file)))
        } else if lower.ends_with(".tar") {
            let file = open_buffered(installer_path)?;
            ("TAR", Box::new(file))
        } else {
            return Err(format!(
                "未知 tarball 扩展名 (文件: {})。仅支持 .tar.gz/.tgz/.tar.xz/.tar",
                installer_path.display()
            ));
        };

    if let Some(parent) = app_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建便携父目录失败 ({}): {}", parent.display(), e))?;
    }
    let staging_path = sibling_temp_dir(app_dir, "stage")?;
    let mut staging_guard = StagingDirGuard::new(staging_path);
    let staging_dir = staging_guard.path().to_path_buf();

    let mut archive = tar::Archive::new(reader);
    let mut tracker = ExtractTracker::new(limits);
    let staged_main_exe = match unpack_tar_entries(&mut archive, &staging_dir, &mut tracker) {
        Ok(main_exe) => main_exe,
        Err(reason) => {
            tracker.rollback();
            return Err(format!(
                "解压 {} 归档失败 (文件: {}): {}",
                kind,
                installer_path.display(),
                abort_message(&reason)
            ));
        }
    };

    // 仅当全部条目共享唯一顶层公共目录时剥离该目录，多根或含顶层文件时完整保留原结构。
    let promote_dir = single_top_level_dir(&staging_dir).unwrap_or_else(|| staging_dir.clone());
    atomic_swap_dir(&promote_dir, app_dir)?;
    if promote_dir == staging_dir {
        staging_guard.disarm();
    }
    // 若 promote_dir 为 staging_dir 子目录，staging_guard 析构时清理空壳外层暂存目录。

    let main_exe = staged_main_exe.and_then(|p| {
        p.strip_prefix(&promote_dir)
            .ok()
            .map(|rel| app_dir.join(rel))
    });

    #[cfg(target_os = "windows")]
    if let Some(ref exe) = main_exe {
        crate::installer::paths::create_desktop_shortcut(shortcut_label, exe);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&main_exe, shortcut_label);

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}

#[cfg(test)]
mod extract_guard_tests {
    use super::*;

    const MAX_EXTRACT_TOTAL_BYTES: u64 = DEFAULT_EXTRACT_LIMITS.max_total_bytes;
    const MAX_EXTRACT_ENTRIES: usize = DEFAULT_EXTRACT_LIMITS.max_entries;

    fn tiny_limits(max_total_bytes: u64, max_entries: usize) -> ExtractLimits {
        ExtractLimits {
            max_total_bytes,
            max_entries,
        }
    }

    /// 把 ZIP 中所有本地头与中央目录记录的「未压缩大小」字段改写为 `fake`，模拟谎报声明的炸弹包。
    fn forge_zip_uncompressed_size(bytes: &mut [u8], fake: u32) {
        let fake = fake.to_le_bytes();
        let mut i = 0;
        while i + 4 <= bytes.len() {
            match &bytes[i..i + 4] {
                [0x50, 0x4b, 0x03, 0x04] if i + 26 <= bytes.len() => {
                    bytes[i + 22..i + 26].copy_from_slice(&fake);
                    i += 4;
                }
                [0x50, 0x4b, 0x01, 0x02] if i + 28 <= bytes.len() => {
                    bytes[i + 24..i + 28].copy_from_slice(&fake);
                    i += 4;
                }
                _ => i += 1,
            }
        }
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(data).unwrap();
        }
        zw.finish().unwrap();
    }

    #[test]
    fn quota_rejects_entry_overflow_and_byte_bomb() {
        let l = DEFAULT_EXTRACT_LIMITS;
        assert!(check_extract_quota(l, 0, 1024, 10).is_ok());
        assert!(check_extract_quota(l, MAX_EXTRACT_TOTAL_BYTES - 1, 1, 1).is_ok());
        assert!(check_extract_quota(l, 0, 0, MAX_EXTRACT_ENTRIES + 1).is_err());
        assert!(check_extract_quota(l, MAX_EXTRACT_TOTAL_BYTES - 1, 2, 1).is_err());
        // u64 溢出饱和判定不 panic
        assert!(check_extract_quota(l, u64::MAX, 1, 1).is_err());
    }

    #[test]
    fn copy_capped_stops_at_remaining_plus_one() {
        let limits = tiny_limits(8, 10);
        let mut sink = Vec::new();
        let err = copy_capped(&mut io::repeat(b'x'), &mut sink, 8, limits).unwrap_err();
        assert!(err.contains("疑似归档炸弹"), "{err}");
        assert_eq!(sink.len(), 9, "写入量必须硬限在 remaining + 1");
        let mut sink = Vec::new();
        let n = copy_capped(&mut &b"12345678"[..], &mut sink, 8, limits).unwrap();
        assert_eq!(n, 8, "恰好用满配额放行");
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
        assert!(
            dir.path().exists(),
            "pre-existing dir must survive rollback"
        );
    }

    #[test]
    fn create_dir_all_tracked_propagates_error() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        std::fs::write(&blocker, b"x").unwrap();
        let mut created = Vec::new();
        assert!(create_dir_all_tracked(&blocker.join("sub"), &mut created).is_err());
        assert!(created.is_empty());
    }

    #[test]
    fn zip_install_extracts_entries_and_tracks_quota() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("app.zip");
        write_zip(
            &zip_path,
            &[
                ("myapp/app.exe", b"fake-exe-bytes"),
                ("myapp/data/readme.txt", b"hello"),
            ],
        );

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
        assert!(app_dir
            .join("myapp")
            .join("data")
            .join("readme.txt")
            .is_file());
    }

    #[test]
    fn zip_with_forged_small_declared_size_is_capped_and_rolled_back() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("bomb.zip");
        let payload = vec![b'z'; 4096];
        write_zip(
            &zip_path,
            &[("myapp/ok.txt", b"ok"), ("myapp/bomb.bin", &payload)],
        );
        let mut bytes = std::fs::read(&zip_path).unwrap();
        forge_zip_uncompressed_size(&mut bytes, 1);
        std::fs::write(&zip_path, &bytes).unwrap();

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let err =
            install_portable_zip_into(&zip_path, "owner/repo", &app_dir, tiny_limits(1024, 100))
                .expect_err("实际体积超配额必须中止");
        assert!(
            err.contains("声明大小不可信"),
            "必须由实际拷贝硬限拦下: {err}"
        );
        assert!(err.contains("已回滚"), "{err}");
        assert!(
            !app_dir.exists(),
            "本次新建的 app_dir 与已写文件必须整体回滚"
        );
    }

    #[test]
    fn zip_entry_count_includes_directories() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("dirs.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        for i in 0..5 {
            zw.add_directory(format!("d{i}/"), zip::write::SimpleFileOptions::default())
                .unwrap();
        }
        zw.finish().unwrap();

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let err =
            install_portable_zip_into(&zip_path, "owner/repo", &app_dir, tiny_limits(1024, 3))
                .expect_err("纯目录条目同样受条目上限约束");
        assert!(err.contains("条目数"), "{err}");
        assert!(!app_dir.exists());
    }

    #[test]
    fn zip_symlink_entries_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("link.zip");
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        zw.add_symlink(
            "myapp/escape",
            "../../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zw.start_file("myapp/a.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"a").unwrap();
        zw.finish().unwrap();

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        install_portable_zip_into(&zip_path, "owner/repo", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();
        assert!(app_dir.join("myapp").join("a.txt").is_file());
        assert!(
            std::fs::symlink_metadata(app_dir.join("myapp").join("escape")).is_err(),
            "软链条目不得落盘"
        );
    }

    #[test]
    fn zip_corrupt_entry_rolls_back_partial_output() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("corrupt.zip");
        write_zip(
            &zip_path,
            &[
                ("myapp/first.txt", b"first"),
                ("myapp/second.txt", &[b's'; 2048]),
            ],
        );
        // 破坏第二个条目的压缩数据：解码或 CRC 校验失败。
        let mut bytes = std::fs::read(&zip_path).unwrap();
        let second = bytes
            .windows(16)
            .position(|w| w == b"myapp/second.txt")
            .unwrap();
        for b in bytes.iter_mut().skip(second + 16).take(8) {
            *b = 0xff;
        }
        std::fs::write(&zip_path, &bytes).unwrap();

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let res =
            install_portable_zip_into(&zip_path, "owner/repo", &app_dir, DEFAULT_EXTRACT_LIMITS);
        assert!(res.is_err(), "损坏条目必须报错");
        assert!(!app_dir.exists(), "错误路径必须回滚已解出的文件与目录");
    }

    fn append_tar_file<W: Write>(tb: &mut tar::Builder<W>, path: &str, data: &[u8], mode: u32) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        tb.append_data(&mut header, path, data).unwrap();
    }

    #[test]
    fn tar_install_extracts_entries_within_quota() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("app.tar");
        let f = std::fs::File::create(&tar_path).unwrap();
        {
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "myapp/data.txt", b"hello", 0o644);
            append_tar_file(&mut tb, "myapp/bin/run", b"#!/x", 0o755);
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

    #[test]
    fn tar_over_byte_quota_aborts_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("big.tar");
        let f = std::fs::File::create(&tar_path).unwrap();
        {
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "myapp/a.txt", b"small", 0o644);
            append_tar_file(&mut tb, "myapp/deep/b.bin", &[b'b'; 4096], 0o644);
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let err = install_portable_tarball_into(
            &tar_path,
            "owner/repo",
            &app_dir,
            tiny_limits(1024, 100),
        )
        .expect_err("超配额必须中止");
        assert!(err.contains("已回滚"), "{err}");
        assert!(!app_dir.exists(), "已写文件与新建目录必须整体回滚");
    }

    #[test]
    fn tar_with_forged_small_header_is_capped_and_rolled_back() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("forged.tar");
        let mut f = std::fs::File::create(&tar_path).unwrap();
        {
            let mut tb = std::mem::ManuallyDrop::new(tar::Builder::new(&mut f));
            append_tar_file(&mut tb, "myapp/ok.txt", b"ok", 0o644);
            let pax_body = b"13 size=4096\n";
            let mut pax_hdr = tar::Header::new_ustar();
            pax_hdr.set_entry_type(tar::EntryType::XHeader);
            pax_hdr.set_size(pax_body.len() as u64);
            pax_hdr.set_mode(0o644);
            pax_hdr.set_cksum();
            tb.append_data(&mut pax_hdr, "PaxHeader/bomb.bin", &pax_body[..])
                .unwrap();
        }
        // 紧随 PAX 扩展头写入 ustar 头部声明 size=0 的条目，后接 4096 字节载荷：
        // `entry.header().size()` 返回 0（绕过预检），必须由 `copy_capped` 硬限拦下并回滚。
        let mut forged_hdr = tar::Header::new_ustar();
        forged_hdr.set_entry_type(tar::EntryType::Regular);
        forged_hdr.set_path("myapp/deep/bomb.bin").unwrap();
        forged_hdr.set_size(0);
        forged_hdr.set_mode(0o644);
        forged_hdr.set_cksum();
        f.write_all(forged_hdr.as_bytes()).unwrap();
        f.write_all(&[b'b'; 4096]).unwrap();
        f.write_all(&[0u8; 1024]).unwrap();

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let err = install_portable_tarball_into(
            &tar_path,
            "owner/repo",
            &app_dir,
            tiny_limits(1024, 100),
        )
        .expect_err("谎报小头部声明的实际超配额 tar 必须中止");
        assert!(
            err.contains("声明大小不可信"),
            "必须由实际拷贝硬限拦下: {err}"
        );
        assert!(err.contains("已回滚"), "{err}");
        assert!(!app_dir.exists(), "已写文件与新建目录必须整体回滚");
    }

    #[test]
    fn tar_entry_count_includes_symlinks_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("links.tar");
        let f = std::fs::File::create(&tar_path).unwrap();
        {
            let mut tb = tar::Builder::new(f);
            for i in 0..5 {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.set_mode(0o777);
                tb.append_link(&mut header, format!("myapp/l{i}"), "target")
                    .unwrap();
            }
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("app");
        let err =
            install_portable_tarball_into(&tar_path, "owner/repo", &app_dir, tiny_limits(1024, 3))
                .expect_err("软链条目同样受条目上限约束");
        assert!(err.contains("条目数"), "{err}");
        assert!(!app_dir.exists());
    }

    /// 构造带原始任意路径（含 `../`、绝对路径、Windows 盘符前缀）的 ustar 条目并写入流。
    fn write_raw_tar_entry<W: Write>(
        out: &mut W,
        raw_path: &[u8],
        entry_type: tar::EntryType,
        link_name: Option<&[u8]>,
        data: &[u8],
    ) {
        let mut hdr = tar::Header::new_ustar();
        hdr.set_entry_type(entry_type);
        hdr.set_size(data.len() as u64);
        hdr.set_mode(0o644);
        {
            let bytes = hdr.as_mut_bytes();
            let n = raw_path.len().min(100);
            bytes[..n].copy_from_slice(&raw_path[..n]);
            if let Some(link) = link_name {
                let ln = link.len().min(100);
                bytes[157..157 + ln].copy_from_slice(&link[..ln]);
            }
        }
        hdr.set_cksum();
        out.write_all(hdr.as_bytes()).unwrap();
        out.write_all(data).unwrap();
        let rem = data.len() % 512;
        if rem != 0 {
            out.write_all(&vec![0u8; 512 - rem]).unwrap();
        }
    }

    #[test]
    fn zip_slip_absolute_and_windows_prefix_entries_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("slip.zip");
        write_zip(
            &zip_path,
            &[
                ("../escape1.txt", b"pwn1"),
                ("myapp/../../escape2.txt", b"pwn2"),
                ("/abs_escape.txt", b"pwn3"),
                (r"C:\evil_escape.txt", b"pwn4"),
                (r"..\win_escape.txt", b"pwn5"),
                ("myapp/safe.txt", b"safe"),
            ],
        );

        let base = tempfile::tempdir().unwrap();
        let nested_parent = base.path().join("apps");
        let app_dir = nested_parent.join("target");
        install_portable_zip_into(&zip_path, "owner/repo", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();

        assert_eq!(
            std::fs::read(app_dir.join("myapp").join("safe.txt")).unwrap(),
            b"safe"
        );
        assert!(!nested_parent.join("escape1.txt").exists());
        assert!(!nested_parent.join("escape2.txt").exists());
        assert!(!nested_parent.join("win_escape.txt").exists());
        assert!(!base.path().join("escape1.txt").exists());
        assert!(!base.path().join("escape2.txt").exists());
        assert!(!app_dir.join("abs_escape.txt").exists());
        assert!(!app_dir.join("evil_escape.txt").exists());
    }

    #[test]
    fn tar_traversal_absolute_windows_prefix_and_hardlink_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("evil.tar");
        {
            let mut f = std::fs::File::create(&tar_path).unwrap();
            write_raw_tar_entry(
                &mut f,
                b"../escape1.txt",
                tar::EntryType::Regular,
                None,
                b"pwn1",
            );
            write_raw_tar_entry(
                &mut f,
                b"myapp/../../escape2.txt",
                tar::EntryType::Regular,
                None,
                b"pwn2",
            );
            write_raw_tar_entry(
                &mut f,
                b"/etc/zstore_evil.txt",
                tar::EntryType::Regular,
                None,
                b"pwn3",
            );
            write_raw_tar_entry(
                &mut f,
                br"C:\evil\win.txt",
                tar::EntryType::Regular,
                None,
                b"pwn4",
            );
            write_raw_tar_entry(
                &mut f,
                br"..\win_escape.txt",
                tar::EntryType::Regular,
                None,
                b"pwn5",
            );
            write_raw_tar_entry(
                &mut f,
                b"myapp/hardlink_escape",
                tar::EntryType::Link,
                Some(b"../../outside_secret"),
                b"",
            );
            write_raw_tar_entry(
                &mut f,
                b"myapp/safe.txt",
                tar::EntryType::Regular,
                None,
                b"ok",
            );
            // tar 结束双 512 零块
            f.write_all(&[0u8; 1024]).unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let nested_parent = base.path().join("apps");
        let app_dir = nested_parent.join("target");
        install_portable_tarball_into(&tar_path, "owner/repo", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();

        assert_eq!(std::fs::read(app_dir.join("safe.txt")).unwrap(), b"ok");
        assert!(!app_dir.join("hardlink_escape").exists());
        assert!(!nested_parent.join("escape1.txt").exists());
        assert!(!nested_parent.join("escape2.txt").exists());
        assert!(!nested_parent.join("win_escape.txt").exists());
        assert!(!base.path().join("escape1.txt").exists());
        assert!(!base.path().join("escape2.txt").exists());
    }

    #[test]
    fn tar_multi_root_preserves_top_level_dirs_without_collision() {
        // 回归 F-13：多顶层目录（bin/、lib/、etc/）绝不能无条件剥离首段导致拍扁覆盖。
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("multi.tar");
        {
            let f = std::fs::File::create(&tar_path).unwrap();
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "bin/app", b"binary", 0o755);
            append_tar_file(&mut tb, "bin/config", b"bin-cfg", 0o644);
            append_tar_file(&mut tb, "lib/foo.so", b"shared-lib", 0o644);
            append_tar_file(&mut tb, "etc/config", b"etc-cfg", 0o644);
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("multi-app");
        install_portable_tarball_into(&tar_path, "owner/multi", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();

        assert_eq!(
            std::fs::read(app_dir.join("bin").join("app")).unwrap(),
            b"binary"
        );
        assert_eq!(
            std::fs::read(app_dir.join("bin").join("config")).unwrap(),
            b"bin-cfg"
        );
        assert_eq!(
            std::fs::read(app_dir.join("lib").join("foo.so")).unwrap(),
            b"shared-lib"
        );
        assert_eq!(
            std::fs::read(app_dir.join("etc").join("config")).unwrap(),
            b"etc-cfg"
        );
    }

    #[test]
    fn tar_top_level_file_alongside_dir_does_not_strip_dir() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("mixed.tar");
        {
            let f = std::fs::File::create(&tar_path).unwrap();
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "README.md", b"readme", 0o644);
            append_tar_file(&mut tb, "bin/tool", b"tool-bin", 0o755);
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("mixed-app");
        install_portable_tarball_into(&tar_path, "owner/mixed", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();

        assert_eq!(std::fs::read(app_dir.join("README.md")).unwrap(), b"readme");
        assert_eq!(
            std::fs::read(app_dir.join("bin").join("tool")).unwrap(),
            b"tool-bin"
        );
    }

    #[test]
    fn portable_zip_mid_upgrade_failure_preserves_existing_v1_files() {
        // 回归 F-09：升级 ZIP 中途失败（即使先写同名文件再超限）绝不得破坏或删除原有 v1 文件。
        let dir = tempfile::tempdir().unwrap();
        let v1_zip = dir.path().join("v1.zip");
        write_zip(
            &v1_zip,
            &[
                ("myapp/app.exe", b"v1-exe"),
                ("myapp/config.json", b"v1-config"),
                ("myapp/only_v1.txt", b"stay-intact"),
            ],
        );

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("owner-repo");
        install_portable_zip_into(&v1_zip, "MyApp", &app_dir, DEFAULT_EXTRACT_LIMITS).unwrap();

        let v2_bad_zip = dir.path().join("v2-bad.zip");
        write_zip(
            &v2_bad_zip,
            &[
                ("myapp/app.exe", b"v2-partial"),
                ("myapp/huge.bin", &[b'X'; 4096]),
            ],
        );

        let err = install_portable_zip_into(&v2_bad_zip, "MyApp", &app_dir, tiny_limits(512, 100))
            .expect_err("over-quota upgrade must fail");
        assert!(err.contains("已回滚"), "{err}");

        // 原有 v1 全部文件必须完好无损
        assert_eq!(
            std::fs::read(app_dir.join("myapp").join("app.exe")).unwrap(),
            b"v1-exe"
        );
        assert_eq!(
            std::fs::read(app_dir.join("myapp").join("config.json")).unwrap(),
            b"v1-config"
        );
        assert_eq!(
            std::fs::read(app_dir.join("myapp").join("only_v1.txt")).unwrap(),
            b"stay-intact"
        );
        // 不得残留暂存/备份目录
        let siblings: Vec<_> = std::fs::read_dir(base.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(siblings, vec![std::ffi::OsString::from("owner-repo")]);
    }

    #[test]
    fn portable_tar_mid_upgrade_failure_preserves_existing_v1_and_valid_upgrade_replaces_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let v1_tar = dir.path().join("v1.tar");
        {
            let f = std::fs::File::create(&v1_tar).unwrap();
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "myapp/data.txt", b"v1-data", 0o644);
            append_tar_file(&mut tb, "myapp/old.txt", b"v1-only", 0o644);
            tb.finish().unwrap();
        }

        let base = tempfile::tempdir().unwrap();
        let app_dir = base.path().join("owner-repo");
        install_portable_tarball_into(&v1_tar, "MyApp", &app_dir, DEFAULT_EXTRACT_LIMITS).unwrap();

        let v2_bad_tar = dir.path().join("v2-bad.tar");
        {
            let f = std::fs::File::create(&v2_bad_tar).unwrap();
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "myapp/data.txt", b"v2-partial", 0o644);
            append_tar_file(&mut tb, "myapp/bomb.bin", &[b'b'; 4096], 0o644);
            tb.finish().unwrap();
        }
        install_portable_tarball_into(&v2_bad_tar, "MyApp", &app_dir, tiny_limits(512, 100))
            .expect_err("over-quota tar upgrade must fail");

        assert_eq!(std::fs::read(app_dir.join("data.txt")).unwrap(), b"v1-data");
        assert_eq!(std::fs::read(app_dir.join("old.txt")).unwrap(), b"v1-only");

        // 合法 v2 升级应原子替换并清除旧版遗留文件与所有临时目录
        let v2_good_tar = dir.path().join("v2-good.tar");
        {
            let f = std::fs::File::create(&v2_good_tar).unwrap();
            let mut tb = tar::Builder::new(f);
            append_tar_file(&mut tb, "myapp/data.txt", b"v2-data", 0o644);
            tb.finish().unwrap();
        }
        install_portable_tarball_into(&v2_good_tar, "MyApp", &app_dir, DEFAULT_EXTRACT_LIMITS)
            .unwrap();
        assert_eq!(std::fs::read(app_dir.join("data.txt")).unwrap(), b"v2-data");
        assert!(!app_dir.join("old.txt").exists());
        let siblings: Vec<_> = std::fs::read_dir(base.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(siblings, vec![std::ffi::OsString::from("owner-repo")]);
    }

    #[test]
    fn atomic_swap_dir_restores_v1_from_backup_when_commit_rename_fails() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("owner-repo");
        let staged = base.path().join(".owner-repo.zstore-stage-test");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("app.txt"), b"v1-live").unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("app.txt"), b"v2-staged").unwrap();

        let mut step = 0usize;
        let err = atomic_swap_dir_with(&staged, &dest, |from, to| {
            step += 1;
            if step == 2 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected swap error",
                ));
            }
            std::fs::rename(from, to)
        })
        .expect_err("injected swap error must fail");

        assert!(err.contains("已恢复旧版本"), "{err}");
        assert_eq!(std::fs::read(dest.join("app.txt")).unwrap(), b"v1-live");
    }

    #[test]
    fn portable_shortcut_label_prefers_app_name_over_app_id() {
        assert_eq!(
            portable_shortcut_label(Some("PicGo"), "molunerfinn/picgo"),
            "PicGo"
        );
        assert_eq!(
            portable_shortcut_label(Some("   "), "molunerfinn/picgo"),
            "molunerfinn/picgo"
        );
        assert_eq!(
            portable_shortcut_label(None, "molunerfinn/picgo"),
            "molunerfinn/picgo"
        );
    }
}
