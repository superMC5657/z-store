use super::{AppScanner, ScanConfig};
use std::path::{Path, PathBuf};

impl AppScanner {
    /// 清理 DisplayIcon 字符串（去掉 ,0、,-1 以及多余引号）
    pub fn clean_display_icon(raw: &str) -> Option<PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let unquoted = if let Some(stripped) = trimmed.strip_prefix('"') {
            if let Some(second_quote) = stripped.find('"') {
                &stripped[..second_quote]
            } else {
                trimmed.trim_matches('"')
            }
        } else if let Some(comma_pos) = trimmed.rfind(',') {
            let after_comma = &trimmed[comma_pos + 1..];
            if after_comma.chars().all(|c| c.is_ascii_digit() || c == '-') {
                &trimmed[..comma_pos]
            } else {
                trimmed
            }
        } else {
            trimmed
        };

        let path = PathBuf::from(unquoted.trim());
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk"))
        {
            return Some(path);
        }
        // Linux：接受无扩展名的绝对路径可执行文件（如 /usr/bin/motrix、/opt/Motrix/motrix）。
        // Windows 语义不变（非 exe/lnk 一律 None）；此处用 cfg! 保持 Windows 编译产物与旧逻辑一致，
        // 且仅接受 Unix 绝对路径，避免把 `C:\App\*.dll` 误判（存量单测在 Linux 主机上仍须通过）。
        if cfg!(target_os = "linux") {
            let s = unquoted.trim();
            if s.starts_with('/') && !s.contains(',') {
                let p = PathBuf::from(s);
                // 排除明显的非可执行资源后缀；无扩展名或 .bin/.run/.AppImage 均放行
                // （存在性由调用方校验，此处只做形状过滤）。
                let lower = s.to_lowercase();
                let blocked = lower.ends_with(".dll")
                    || lower.ends_with(".so")
                    || lower.ends_with(".pak")
                    || lower.ends_with(".bin.2")
                    || lower.contains("package cache")
                    || lower.contains("windows\\installer");
                if !blocked {
                    return Some(p);
                }
            }
        }
        None
    }

    pub fn is_installer_or_cache_path(p: &Path) -> bool {
        let lower = p.to_string_lossy().to_lowercase();
        lower.contains("package cache")
            || lower.contains("temp")
            || lower.contains("windows\\installer")
            || lower.contains("unins")
            || lower.contains("installer")
            || lower.contains("bundle")
            || lower.contains("setup")
    }

    pub fn find_exe_in_directory(dir: &Path, config: &ScanConfig) -> Option<String> {
        if !dir.is_dir() {
            return None;
        }

        // 1. 根目录精准匹配配置中的可执行文件名
        for name in &config.target_executables {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }

        // 1b. Linux：裸名兼容 —— 配置中若为 `motrix.exe`，同目录下 `motrix`（去扩展名）也视为命中
        // （deb 落盘多为无扩展名；Windows 分支不受影响，因该块仅在 linux 生效）。
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

        // 2. 常见子目录匹配（基于配置中配置的 search_subdirs 或标准子目录）
        for sub in &config.search_subdirs {
            let sub_dir = dir.join(sub);
            if sub_dir.is_dir() {
                for name in &config.target_executables {
                    let candidate = sub_dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 3. 遍历一级子目录查找配置中的可执行程序（例如 WinGet 解压包目录）
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() && !Self::is_installer_or_cache_path(&p) {
                    for name in &config.target_executables {
                        let candidate = p.join(name);
                        if candidate.is_file() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }

        // 4. 根目录内搜索首个非卸载/安装器类的可执行文件
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                    && !Self::is_installer_or_cache_path(&p)
                {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }

        // 5. Linux：无扩展名可执行位文件回退（/opt/<App>/ 下的 electron 主程序等多为裸名）。
        // 仅在 linux 生效；Windows 直接落到 None，行为不变。
        #[cfg(target_os = "linux")]
        {
            if let Some(found) = Self::find_linux_executable_in_directory(dir, config) {
                return Some(found);
            }
        }

        None
    }

    /// Linux 可执行位判定（`chmod +x` 任一执行位）。非 Unix 平台恒返回 false（仅供 linux 分支调用）。
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

    /// Linux 目录内裸名可执行文件扫描：优先命中配置名（含去 `.exe` 后的裸名），
    /// 其次取首个非安装器类的可执行位文件。供 `find_exe_in_directory` linux 回退调用。
    #[cfg(target_os = "linux")]
    pub fn find_linux_executable_in_directory(
        dir: &Path,
        config: &ScanConfig,
    ) -> Option<String> {
        // 5a. 配置名（含裸名形式）精准命中
        let mut wanted: Vec<String> = Vec::new();
        for name in &config.target_executables {
            let lower = name.to_lowercase();
            wanted.push(lower.clone());
            if lower.ends_with(".exe") {
                wanted.push(lower[..lower.len() - 4].to_string());
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            // 先做精准名匹配（大小写不敏感）
            let mut fallback: Option<String> = None;
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
                if wanted.iter().any(|w| *w == fname) && Self::has_exec_permission(&p) {
                    return Some(p.to_string_lossy().to_string());
                }
                // 候选回退：首个可执行位、无扩展名或非 .so/.pak 资源文件
                if fallback.is_none()
                    && Self::has_exec_permission(&p)
                    && p.extension().is_none()
                {
                    let fl = fname.clone();
                    if !fl.starts_with("unins")
                        && !fl.starts_with("uninstall")
                        && !fl.contains("setup")
                        && !fl.contains("installer")
                    {
                        fallback = Some(p.to_string_lossy().to_string());
                    }
                }
            }
            if let Some(f) = fallback {
                return Some(f);
            }
        }
        None
    }
}
