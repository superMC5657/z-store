//! 本地已装版本探测：注册表 DisplayVersion 优先，缺失时读主程序自带的版本资源。
//! 两者都没有时视为版本未知，不拿收录库的最新版本冒充本地版本。

use super::{AppScanner, ScannedRawApp};

/// 把版本资源的四段数字格式化为版本号：末段为 0 时省略（至少保留三段）；全 0 视为未设置。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn format_fixed_version(parts: [u16; 4]) -> Option<String> {
    if parts.iter().all(|p| *p == 0) {
        return None;
    }
    let keep = if parts[3] == 0 { 3 } else { 4 };
    Some(
        parts[..keep]
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join("."),
    )
}

/// 去掉注册表路径值常见的首尾空白与包裹引号。
pub(crate) fn unquote_path(raw: &str) -> &str {
    raw.trim().trim_matches('"')
}

/// 两个版本号是否相同：忽略首尾空白与前导 `v`/`V`。
pub fn same_version(a: &str, b: &str) -> bool {
    let strip = |v: &str| {
        let v = v.trim();
        v.strip_prefix(['v', 'V']).unwrap_or(v).to_string()
    };
    strip(a) == strip(b)
}

/// 比较、匹配路径用的形态：统一分隔符、去引号与末尾分隔符、忽略大小写。
pub(crate) fn normalize_path(raw: &str) -> String {
    unquote_path(raw)
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

impl AppScanner {
    /// 读取可执行文件版本资源中的产品版本（Windows VERSIONINFO）；非 exe 或无版本资源返回 None。
    #[cfg(target_os = "windows")]
    pub fn read_exe_version(path: &str) -> Option<String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
        };

        let p = std::path::Path::new(unquote_path(path));
        if !p.is_file()
            || !p
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return None;
        }
        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
        let root: Vec<u16> = "\\".encode_utf16().chain(Some(0)).collect();

        // SAFETY: 两个宽字符串均以 0 结尾且在调用期间存活；缓冲区按 GetFileVersionInfoSizeW
        // 返回的长度分配；VerQueryValueW 返回的指针指向该缓冲区内部，读取前已校验长度。
        unsafe {
            let mut handle = 0u32;
            let size = GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            if GetFileVersionInfoW(wide.as_ptr(), 0, size, buf.as_mut_ptr().cast()) == 0 {
                return None;
            }
            let mut info: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            if VerQueryValueW(buf.as_ptr().cast(), root.as_ptr(), &mut info, &mut len) == 0
                || info.is_null()
                || (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
            {
                return None;
            }
            let fixed = std::ptr::read_unaligned(info as *const VS_FIXEDFILEINFO);
            if fixed.dwSignature != 0xFEEF_04BD {
                return None;
            }
            format_fixed_version([
                (fixed.dwProductVersionMS >> 16) as u16,
                (fixed.dwProductVersionMS & 0xFFFF) as u16,
                (fixed.dwProductVersionLS >> 16) as u16,
                (fixed.dwProductVersionLS & 0xFFFF) as u16,
            ])
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn read_exe_version(_path: &str) -> Option<String> {
        None
    }

    /// 导入与刷新共用的本地版本口径：注册表版本非空即用，否则读主程序版本资源。
    pub fn detect_local_version(
        registry_version: &str,
        executable: Option<&str>,
        read_exe: impl Fn(&str) -> Option<String>,
    ) -> Option<String> {
        let reg = registry_version.trim();
        if !reg.is_empty() {
            return Some(reg.to_string());
        }
        executable.and_then(read_exe)
    }

    /// 找到 `install_path` 所属的注册表条目（安装目录包含该路径，或 DisplayIcon 指向它），
    /// 多个命中时取安装目录最长的那条。
    pub fn find_registry_entry_for_path<'a>(
        entries: &'a [ScannedRawApp],
        install_path: &str,
    ) -> Option<&'a ScannedRawApp> {
        let target = normalize_path(install_path);
        if target.is_empty() {
            return None;
        }
        entries
            .iter()
            .filter_map(|e| {
                let loc = e
                    .install_location
                    .as_deref()
                    .map(normalize_path)
                    .filter(|l| !l.is_empty());
                let by_location = loc
                    .as_deref()
                    .filter(|l| target == *l || target.starts_with(&format!("{l}\\")))
                    .map(str::len);
                let by_icon = e
                    .display_icon
                    .as_deref()
                    .and_then(Self::clean_display_icon)
                    .filter(|icon| normalize_path(&icon.to_string_lossy()) == target)
                    .map(|_| usize::MAX);
                by_icon.or(by_location).map(|rank| (rank, e))
            })
            .max_by_key(|(rank, _)| *rank)
            .map(|(_, e)| e)
    }

    /// 已导入应用的安装时间：取已枚举注册表条目中所属条目的 `installed_at`，
    /// 找不到时回退主程序/安装目录的文件系统时间（不重新枚举注册表）。
    pub fn detect_installed_at_from_entries(
        entries: &[ScannedRawApp],
        install_path: &str,
    ) -> Option<i64> {
        Self::find_registry_entry_for_path(entries, install_path)
            .and_then(|e| e.installed_at)
            .or_else(|| Self::detect_path_installed_at(install_path))
    }

    /// 已导入应用的当前本地版本：须先找到其注册表条目（与导入同源），找不到则返回 None 保持原值，
    /// 避免拿格式不同的主程序版本覆盖原本来自注册表的版本。找到条目但注册表与主程序都没有版本时
    /// 返回空串（版本未知），以清掉早先导入时用收录库最新版填充的值。
    pub fn detect_installed_version(
        entries: &[ScannedRawApp],
        install_path: &str,
        read_exe: impl Fn(&str) -> Option<String>,
    ) -> Option<String> {
        let entry = Self::find_registry_entry_for_path(entries, install_path)?;
        let exe = unquote_path(install_path);
        let exe = std::path::Path::new(exe)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            .then_some(exe);
        Some(Self::detect_local_version(&entry.display_version, exe, read_exe).unwrap_or_default())
    }
}
