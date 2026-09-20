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
        if path.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk")
        }) {
            Some(path)
        } else {
            None
        }
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

        None
    }
}
