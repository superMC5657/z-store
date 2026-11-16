use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

/// 剥离末尾 `,N` / `,-N` 图标资源索引（逗号后须全为数字或 `-`）。
fn strip_icon_index(s: &str) -> &str {
    match s.rsplit_once(',') {
        Some((pre, suf))
            if !suf.trim().is_empty()
                && suf.trim().chars().all(|c| c.is_ascii_digit() || c == '-') =>
        {
            pre.trim_end()
        }
        _ => s,
    }
}

/// 路径各段（小写，`/` 与 `\` 均作分隔）。
fn lower_components(p: &Path) -> Vec<String> {
    p.to_string_lossy()
        .split(['/', '\\'])
        .filter(|c| !c.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// 版本目录排序键：`app-3.6.10` → `[3, 6, 10]`（非数字段计 0）。
fn squirrel_version_key(dir_name: &str) -> Vec<u64> {
    dir_name
        .get(4..)
        .unwrap_or("")
        .split(['.', '-'])
        .map(|seg| seg.parse::<u64>().unwrap_or(0))
        .collect()
}

impl AppScanner {
    /// 清理 DisplayIcon 字符串：先剥引号外的 `,N`，再去包裹引号，再剥引号内的 `,N`
    /// （兼容 `"C:\App\app.exe",0` 与 `"C:\App\app.exe,0"` 两种形态）。
    pub fn clean_display_icon(raw: &str) -> Option<PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let outer = strip_icon_index(trimmed);
        let unquoted = match outer.strip_prefix('"') {
            Some(rest) => match rest.find('"') {
                Some(end) => &rest[..end],
                None => rest,
            },
            None => outer,
        };
        let unquoted = strip_icon_index(unquoted.trim()).trim();
        if unquoted.is_empty() {
            return None;
        }

        let path = PathBuf::from(unquoted);
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk"))
        {
            return Some(path);
        }
        // Linux：接受无扩展名的绝对路径可执行文件（如 /usr/bin/motrix、/opt/Motrix/motrix）。
        // 仅接受 Unix 绝对路径，避免把 `C:\App\*.dll` 误判。
        if cfg!(target_os = "linux") && unquoted.starts_with('/') && !unquoted.contains(',') {
            // 排除明显的非可执行资源后缀；无扩展名或 .bin/.run/.AppImage 均放行
            // （存在性由调用方校验，此处只做形状过滤）。
            let lower = unquoted.to_lowercase();
            let blocked = lower.ends_with(".dll")
                || lower.ends_with(".so")
                || lower.ends_with(".pak")
                || lower.ends_with(".bin.2")
                || lower.contains("package cache")
                || lower.contains("windows\\installer");
            if !blocked {
                return Some(path);
            }
        }
        None
    }

    /// 路径是否位于临时/安装缓存目录：按路径段整段比对，`C:\Users\tempuser`、
    /// `Core Temp` 这类仅含 `temp` 子串的段不算。
    pub fn is_cache_or_temp_directory(p: &Path) -> bool {
        let comps = lower_components(p);
        comps.iter().any(|c| {
            matches!(
                c.as_str(),
                "temp" | "tmp" | "package cache" | "squirreltemp" | "$plugindir"
            ) || c.starts_with("~nsu")
        }) || comps
            .windows(2)
            .any(|w| w[0] == "windows" && w[1] == "installer")
    }

    /// 文件名是否为卸载器、安装器、更新器、崩溃上报等辅助二进制（只看文件名，不看父目录）。
    pub fn is_auxiliary_executable_name(file_name: &str) -> bool {
        let lower = file_name.trim().to_lowercase();
        const EXACT: &[&str] = &[
            "update.exe",
            "updater.exe",
            "squirrel.exe",
            "elevate.exe",
            "crashpad_handler.exe",
            "crashreporter.exe",
            "crash_reporter.exe",
            "createdump.exe",
            "unins000.exe",
            "unins001.exe",
            "uninstall.exe",
            "uninst.exe",
        ];
        if EXACT.contains(&lower.as_str()) {
            return true;
        }
        let stem = lower
            .strip_suffix(".exe")
            .or_else(|| lower.strip_suffix(".msi"))
            .unwrap_or(&lower);
        stem.starts_with("unins") || stem.contains("setup") || stem.contains("installer")
    }

    /// 缓存目录内的任意路径，或文件名为辅助二进制的 `.exe` / `.msi`。
    pub fn is_installer_or_cache_path(p: &Path) -> bool {
        if Self::is_cache_or_temp_directory(p) {
            return true;
        }
        let Some(name) = lower_components(p).pop() else {
            return false;
        };
        (name.ends_with(".exe") || name.ends_with(".msi"))
            && Self::is_auxiliary_executable_name(&name)
    }

    /// 可作主程序的路径：不在缓存目录内，且文件名不是辅助二进制——
    /// 除非该文件名正是 `allowed_targets` 显式声明的主程序（如 `Bulk-Crap-Uninstaller.exe`）。
    pub fn is_valid_app_executable(p: &Path, allowed_targets: &[String]) -> bool {
        if Self::is_cache_or_temp_directory(p) {
            return false;
        }
        let name = lower_components(p).pop().unwrap_or_default();
        !Self::is_auxiliary_executable_name(&name)
            || allowed_targets.iter().any(|t| t.to_lowercase() == name)
    }

    /// 在目录 `dir` 中按配置的主程序名逐个查找。
    fn find_target_in(dir: &Path, config: &ScanConfig) -> Option<String> {
        config.target_executables.iter().find_map(|name| {
            let candidate = dir.join(name);
            (candidate.is_file()
                && Self::is_valid_app_executable(&candidate, &config.target_executables))
            .then(|| candidate.to_string_lossy().to_string())
        })
    }

    pub fn find_exe_in_directory(dir: &Path, config: &ScanConfig) -> Option<String> {
        if !dir.is_dir() || Self::is_cache_or_temp_directory(dir) {
            return None;
        }

        // 1. 根目录精准匹配配置中的可执行文件名
        if let Some(found) = Self::find_target_in(dir, config) {
            return Some(found);
        }

        // 1b. Linux：裸名等价 —— 配置中若为 `motrix.exe`，同目录下 `motrix`（去扩展名）也视为命中
        // （deb 落盘多为无扩展名）。
        #[cfg(target_os = "linux")]
        {
            for name in &config.target_executables {
                let stripped = name
                    .strip_suffix(".exe")
                    .or_else(|| name.strip_suffix(".EXE"))
                    .unwrap_or(name);
                if stripped != name {
                    let candidate = dir.join(stripped);
                    if candidate.is_file() && Self::has_exec_permission(&candidate) {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 2. 常见子目录匹配（配置的 search_subdirs 或标准子目录）
        for sub in &config.search_subdirs {
            let sub_dir = dir.join(sub);
            if sub_dir.is_dir() {
                if let Some(found) = Self::find_target_in(&sub_dir, config) {
                    return Some(found);
                }
            }
        }

        // 3. 一级子目录：Squirrel `app-<ver>` 按版本降序优先，其余子目录随后
        let mut squirrel_dirs: Vec<(Vec<u64>, PathBuf)> = Vec::new();
        let mut other_dirs: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() || Self::is_cache_or_temp_directory(&p) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("app-") {
                    squirrel_dirs.push((squirrel_version_key(&name), p));
                } else {
                    other_dirs.push(p);
                }
            }
        }
        squirrel_dirs.sort_by(|a, b| b.0.cmp(&a.0));
        other_dirs.sort();
        for sub in squirrel_dirs.into_iter().map(|(_, p)| p).chain(other_dirs) {
            if let Some(found) = Self::find_target_in(&sub, config) {
                return Some(found);
            }
        }

        // 4. 根目录回退：唯一的非辅助 `.exe` 直接采纳；多个时只认文件名与配置词元一致的那个，
        //    否则不猜（多二进制目录里首个 `.exe` 常是无关辅助程序）。
        if let Some(found) = Self::pick_root_exe(dir, config) {
            return Some(found);
        }

        // 5. Linux：无扩展名可执行位文件回退（/opt/<App>/ 下的 electron 主程序等多为裸名）。
        #[cfg(target_os = "linux")]
        {
            if let Some(found) = Self::find_linux_executable_in_directory(dir, config) {
                return Some(found);
            }
        }

        None
    }

    /// `find_exe_in_directory` 第 4 步：根目录 `.exe` 回退选择。
    fn pick_root_exe(dir: &Path, config: &ScanConfig) -> Option<String> {
        let mut exes: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                    && !Self::is_installer_or_cache_path(p)
            })
            .collect();
        exes.sort();
        if exes.len() == 1 {
            return exes.pop().map(|p| p.to_string_lossy().to_string());
        }
        let wanted: Vec<String> = config
            .install_dirs
            .iter()
            .map(String::as_str)
            .chain(config.target_executables.iter().map(|t| {
                t.strip_suffix(".exe")
                    .or_else(|| t.strip_suffix(".EXE"))
                    .unwrap_or(t)
            }))
            .map(Self::normalize_fs_token)
            .filter(|t| !t.is_empty())
            .collect();
        exes.into_iter()
            .find(|p| {
                let stem = p
                    .file_stem()
                    .map(|s| Self::normalize_fs_token(&s.to_string_lossy()))
                    .unwrap_or_default();
                wanted.contains(&stem)
            })
            .map(|p| p.to_string_lossy().to_string())
    }

    /// Linux 可执行位判定（`chmod +x` 任一执行位）。非 Unix 平台恒返回 false（仅供 linux 分支调用）。
    #[cfg(any(target_os = "linux", test))]
    pub fn has_exec_permission(p: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(p) {
                return meta.permissions().mode() & 0o111 != 0;
            }
            false
        }
        #[cfg(not(unix))]
        {
            let _ = p;
            false
        }
    }

    /// Linux 目录内裸名可执行文件扫描：仅按配置名（含去 `.exe` 后的裸名）精准命中，
    /// 且须有执行位；无命中即返回 None（禁首个文件兜底，防误启动无关二进制）。
    /// 供 `find_exe_in_directory` linux 回退调用。
    #[cfg(target_os = "linux")]
    pub fn find_linux_executable_in_directory(dir: &Path, config: &ScanConfig) -> Option<String> {
        // 5a. 配置名（含裸名形式）精准命中（大小写不敏感，且须有执行位）
        let mut wanted: Vec<String> = Vec::new();
        for name in &config.target_executables {
            let lower = name.to_lowercase();
            wanted.push(lower.clone());
            if lower.ends_with(".exe") {
                wanted.push(lower[..lower.len() - 4].to_string());
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() || Self::is_installer_or_cache_path(&p) {
                    continue;
                }
                let fname = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if wanted.contains(&fname) && Self::has_exec_permission(&p) {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
        None
    }
}
