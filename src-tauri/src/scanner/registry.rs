use super::types::SourceKind;
use super::version::normalize_path;
use super::{AppScanner, ScanConfig, ScannedRawApp};
use std::collections::HashSet;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

/// 解析注册表中的 InstallDate 字符串（常见格式 YYYYMMDD 或 YYYY-MM-DD / YYYY/MM/DD）转换为 Unix 秒时间戳
pub fn parse_install_date_to_unix(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    let (year, month, day) = if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        let y: i32 = s[0..4].parse().ok()?;
        let m: u32 = s[4..6].parse().ok()?;
        let d: u32 = s[6..8].parse().ok()?;
        (y, m, d)
    } else if s.len() == 10 {
        let parts: Vec<&str> = s.split(['-', '/', '.']).collect();
        if parts.len() == 3 {
            let y: i32 = parts[0].parse().ok()?;
            let m: u32 = parts[1].parse().ok()?;
            let d: u32 = parts[2].parse().ok()?;
            (y, m, d)
        } else {
            return None;
        }
    } else {
        return None;
    };

    if (1990..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day) {
        if let Ok(m) = (month as u8).try_into() {
            if let Ok(date) = time::Date::from_calendar_date(year, m, day as u8) {
                return Some(date.midnight().assume_utc().unix_timestamp());
            }
        }
    }
    None
}

/// 读取 Windows 注册表项本身的最后写入时间戳（FILETIME 转 Unix 秒级时间戳）
#[cfg(target_os = "windows")]
pub fn get_reg_key_last_write_time(key: &winreg::RegKey) -> Option<i64> {
    #[repr(C)]
    struct Filetime {
        low: u32,
        high: u32,
    }
    extern "system" {
        fn RegQueryInfoKeyW(
            hKey: *mut std::ffi::c_void,
            lpClass: *mut u16,
            lpcchClass: *mut u32,
            lpReserved: *mut u32,
            lpcSubKeys: *mut u32,
            lpcbMaxSubKeyLen: *mut u32,
            lpcbMaxClassLen: *mut u32,
            lpcValues: *mut u32,
            lpcbMaxValueNameLen: *mut u32,
            lpcbMaxValueLen: *mut u32,
            lpcbSecurityDescriptor: *mut u32,
            lpftLastWriteTime: *mut Filetime,
        ) -> i32;
    }
    let mut ft = Filetime { low: 0, high: 0 };
    let ret = unsafe {
        RegQueryInfoKeyW(
            key.raw_handle() as _,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ft,
        )
    };
    if ret == 0 {
        let intervals = ((ft.high as u64) << 32) | (ft.low as u64);
        // 1601-01-01 到 1970-01-01 之间的 100 纳秒间隔数（116444736000000000）
        if intervals > 116_444_736_000_000_000 {
            let unix_secs = (intervals - 116_444_736_000_000_000) / 10_000_000;
            return Some(unix_secs as i64);
        }
    }
    None
}

/// 注册表卸载子键名作为应用包标识：去尾随 `_is1`，纯 `{GUID}` 键名不记。
pub fn registry_key_label(key_name: &str) -> Option<String> {
    let trimmed = key_name.trim();
    let base = if trimmed.to_lowercase().ends_with("_is1") {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    };
    let base = base.trim();
    if base.is_empty() || (base.starts_with('{') && base.ends_with('}')) {
        return None;
    }
    Some(base.to_string())
}

/// 从 UninstallString 取出可执行文件路径（引号包裹取引号内；否则截到 `.exe` 末尾；
/// 再否则截到首个 ` /` 或 ` -` 参数前）。
fn uninstall_executable(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.find('"').map(|end| rest[..end].trim().to_string());
    }
    let lower = trimmed.to_lowercase();
    if let Some(idx) = lower.find(".exe") {
        return Some(trimmed[..idx + 4].to_string());
    }
    let cut = [" /", " -"]
        .iter()
        .filter_map(|sep| trimmed.find(sep))
        .min()
        .unwrap_or(trimmed.len());
    let exe = trimmed[..cut].trim();
    (!exe.is_empty()).then(|| exe.to_string())
}

/// UninstallString 所在目录（纯字符串推导，不触盘）：系统卸载宿主（msiexec、rundll32、
/// cmd、powershell）、系统目录、缓存目录，以及盘符根与顶层 `Program Files` 一律拒绝。
pub fn uninstall_string_parent_dir(raw: &str) -> Option<String> {
    let exe = uninstall_executable(raw)?;
    let normalized = exe.replace('/', "\\");
    let lower = normalized.to_lowercase();
    let file_name = lower.rsplit('\\').next().unwrap_or(&lower);
    const HOSTS: &[&str] = &[
        "msiexec",
        "msiexec.exe",
        "rundll32",
        "rundll32.exe",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
    ];
    if HOSTS.contains(&file_name)
        || lower.contains("\\windows\\system32")
        || lower.contains("\\windows\\syswow64")
        || AppScanner::is_cache_or_temp_directory(std::path::Path::new(&normalized))
    {
        return None;
    }
    let (parent, _) = normalized.rsplit_once('\\')?;
    let segments: Vec<&str> = parent.split('\\').filter(|s| !s.is_empty()).collect();
    let too_shallow = segments.len() <= 1
        || (segments.len() == 2 && segments[1].to_lowercase().starts_with("program files"));
    (!too_shallow).then(|| parent.to_string())
}

/// 由 UninstallString 推导安装目录，且该目录须在磁盘上存在。
pub fn infer_install_dir_from_uninstall_string(raw: &str) -> Option<String> {
    uninstall_string_parent_dir(raw).filter(|dir| std::path::Path::new(dir).is_dir())
}

/// WiX Burn 引导包的安装目录回填：组件名与应用名完全相同，或在词边界上互为前缀
/// （双方均不短于 6 个字符），短组件名（`Core`、`SDK`）不会串到无关应用。
pub fn match_wix_component_location(
    app_name: &str,
    components: &std::collections::BTreeMap<String, String>,
) -> Option<String> {
    let app = app_name.trim().to_lowercase();
    if app.is_empty() {
        return None;
    }
    if let Some(loc) = components.get(&app) {
        return Some(loc.clone());
    }
    components
        .iter()
        .find(|(comp, _)| {
            comp.chars().count() >= 6
                && app.chars().count() >= 6
                && (app.starts_with(&format!("{comp} ")) || comp.starts_with(&format!("{app} ")))
        })
        .map(|(_, loc)| loc.clone())
}

/// 新条目补全已有条目缺失的字段（同名同版本出现在多个注册表根时合并）。
pub fn merge_missing_fields(existing: &mut ScannedRawApp, incoming: ScannedRawApp) {
    fn fill<T>(slot: &mut Option<T>, value: Option<T>) {
        if slot.is_none() {
            *slot = value;
        }
    }
    fill(&mut existing.publisher, incoming.publisher);
    fill(&mut existing.install_location, incoming.install_location);
    fill(&mut existing.display_icon, incoming.display_icon);
    fill(&mut existing.uninstall_string, incoming.uninstall_string);
    fill(&mut existing.installed_at, incoming.installed_at);
    fill(&mut existing.registry_key, incoming.registry_key);
    fill(&mut existing.source_kind, incoming.source_kind);
}

/// 已有条目的覆盖索引：归一化安装目录集合 + 归一化 DisplayIcon 主程序集合。
/// 一次建索引 O(N)，单次判定 O(路径深度)；扫描循环中边追加边查询。
#[derive(Debug, Default)]
pub struct CoveredPaths {
    locations: HashSet<String>,
    icons: HashSet<String>,
}

impl CoveredPaths {
    pub fn from_apps(apps: &[ScannedRawApp]) -> Self {
        let mut index = Self::default();
        for app in apps {
            index.insert(app);
        }
        index
    }

    pub fn insert(&mut self, app: &ScannedRawApp) {
        if let Some(loc) = app
            .install_location
            .as_deref()
            .map(normalize_path)
            .filter(|l| !l.is_empty())
        {
            self.locations.insert(loc);
        }
        if let Some(icon) = app
            .display_icon
            .as_deref()
            .and_then(AppScanner::clean_display_icon)
            .map(|icon| normalize_path(&icon.to_string_lossy()))
            .filter(|i| !i.is_empty())
        {
            self.icons.insert(icon);
        }
    }

    /// 目标路径是否已被覆盖：位于某条目的安装目录内（含等于），或等于其 DisplayIcon 主程序。
    /// 「位于目录内」逐个检查目标在每个 `\` 处截断的祖先前缀。
    pub fn covers(&self, target: &str) -> bool {
        let t = normalize_path(target);
        if t.is_empty() {
            return false;
        }
        self.icons.contains(&t)
            || self.locations.contains(&t)
            || t.match_indices('\\')
                .any(|(i, _)| self.locations.contains(&t[..i]))
    }
}

/// 目标路径是否已被已有条目覆盖（单次查询便捷入口；批量判定请复用 [`CoveredPaths`]）。
pub fn is_path_covered(target: &str, existing: &[ScannedRawApp]) -> bool {
    CoveredPaths::from_apps(existing).covers(target)
}

/// Scoop `manifest.json` 中 `bin` / `shortcuts` 字段给出的首个 `.exe` 相对路径。
fn scoop_manifest_exe(manifest: &serde_json::Value) -> Option<String> {
    let first_str = |v: &serde_json::Value| -> Option<String> {
        match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(a) => a.first().and_then(|x| x.as_str()).map(str::to_string),
            _ => None,
        }
    };
    let shortcut = manifest
        .get("shortcuts")
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .filter_map(first_str);
    let bins: Vec<String> = match manifest.get("bin") {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(first_str).collect(),
        _ => Vec::new(),
    };
    shortcut
        .chain(bins)
        .find(|p| p.to_lowercase().ends_with(".exe"))
}

/// 扫描一个 Scoop `apps` 目录：每个 `<slug>/current/manifest.json` 生成一条记录。
pub fn scan_scoop_apps_in_dir(apps_dir: &Path) -> Vec<ScannedRawApp> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(apps_dir) else {
        return out;
    };
    let mut slugs: Vec<_> = entries.flatten().collect();
    slugs.sort_by_key(|e| e.file_name());
    for entry in slugs {
        let slug = entry.file_name().to_string_lossy().to_string();
        if slug.eq_ignore_ascii_case("scoop") {
            continue;
        }
        let current = entry.path().join("current");
        let Ok(text) = std::fs::read_to_string(current.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let version = manifest
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let display_name = manifest
            .get("shortcuts")
            .and_then(|s| s.as_array())
            .and_then(|a| a.first())
            .and_then(|s| s.as_array())
            .and_then(|pair| pair.get(1))
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map_or_else(|| slug.clone(), str::to_string);
        let exe = scoop_manifest_exe(&manifest)
            .map(|rel| current.join(rel.replace('\\', std::path::MAIN_SEPARATOR_STR)))
            .filter(|p| p.is_file())
            .map(|p| p.to_string_lossy().to_string())
            .or_else(|| AppScanner::find_exe_in_directory(&current, &ScanConfig::from(&slug)));
        let current_str = current.to_string_lossy().to_string();
        out.push(ScannedRawApp {
            display_name,
            display_version: version,
            publisher: None,
            install_location: Some(current_str.clone()),
            display_icon: exe,
            uninstall_string: None,
            installed_at: AppScanner::detect_path_installed_at(&current_str),
            registry_key: Some(slug),
            source_kind: Some(SourceKind::Scoop),
        });
    }
    out
}

/// 开始菜单快捷方式文件名中表示非主程序入口的词。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_auxiliary_shortcut_name(lower_name: &str) -> bool {
    ["uninstall", "卸载", "readme", "help", "website", "manual"]
        .iter()
        .any(|w| lower_name.contains(w))
}

impl AppScanner {
    /// Windows 系统已安装应用：三棵卸载注册表根合并 + Scoop + 未登记注册表的开始菜单快捷方式。
    #[cfg(target_os = "windows")]
    pub(crate) fn scan_windows_registry() -> Vec<ScannedRawApp> {
        let mut apps = Self::scan_uninstall_registry();
        let mut covered_index = CoveredPaths::from_apps(&apps);
        for root in Self::scoop_app_roots() {
            for app in scan_scoop_apps_in_dir(&root) {
                let covered = app
                    .install_location
                    .as_deref()
                    .is_some_and(|loc| covered_index.covers(loc));
                if !covered {
                    covered_index.insert(&app);
                    apps.push(app);
                }
            }
        }
        let shortcuts = Self::scan_unregistered_shortcuts(covered_index);
        apps.extend(shortcuts);
        apps
    }

    #[cfg(target_os = "windows")]
    fn scoop_app_roots() -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        let candidates = [
            std::env::var("SCOOP")
                .ok()
                .map(|s| PathBuf::from(s).join("apps")),
            std::env::var("USERPROFILE")
                .ok()
                .map(|s| PathBuf::from(s).join("scoop").join("apps")),
            std::env::var("SCOOP_GLOBAL")
                .ok()
                .map(|s| PathBuf::from(s).join("apps")),
            std::env::var("ProgramData")
                .ok()
                .map(|s| PathBuf::from(s).join("scoop").join("apps")),
        ];
        for c in candidates.into_iter().flatten() {
            let key = normalize_path(&c.to_string_lossy());
            if c.is_dir()
                && !roots
                    .iter()
                    .any(|r| normalize_path(&r.to_string_lossy()) == key)
            {
                roots.push(c);
            }
        }
        roots
    }

    /// 开始菜单 `.lnk`（根 + 一级子目录）中未被注册表/Scoop 覆盖的便携软件；
    /// `covered` 为注册表 + Scoop 条目的覆盖索引，本函数内随新增条目同步追加。
    #[cfg(target_os = "windows")]
    fn scan_unregistered_shortcuts(mut covered: CoveredPaths) -> Vec<ScannedRawApp> {
        let roots = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")),
            std::env::var("ProgramData")
                .ok()
                .map(|p| PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs")),
        ];
        let mut lnks: Vec<PathBuf> = Vec::new();
        for root in roots.into_iter().flatten() {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if let Ok(sub) = std::fs::read_dir(&p) {
                        lnks.extend(sub.flatten().map(|e| e.path()));
                    }
                } else {
                    lnks.push(p);
                }
            }
        }

        let mut out: Vec<ScannedRawApp> = Vec::new();
        for lnk in lnks {
            if !lnk
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("lnk"))
            {
                continue;
            }
            let stem = lnk
                .file_stem()
                .map(|s| s.to_string_lossy().trim().to_string())
                .unwrap_or_default();
            if stem.is_empty() || is_auxiliary_shortcut_name(&stem.to_lowercase()) {
                continue;
            }
            let Some(target) = Self::resolve_lnk_target(&lnk) else {
                continue;
            };
            if !target
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                || !Self::is_valid_app_executable(&target, &[])
            {
                continue;
            }
            let target_str = target.to_string_lossy().to_string();
            if covered.covers(&target_str) {
                continue;
            }
            let lower = target_str.to_lowercase();
            if lower.contains(":\\windows\\") {
                continue;
            }
            let parent = target.parent().map(|p| p.to_string_lossy().to_string());
            let app = ScannedRawApp {
                display_name: stem,
                display_version: Self::read_exe_version(&target_str).unwrap_or_default(),
                publisher: None,
                install_location: parent,
                display_icon: Some(target_str.clone()),
                uninstall_string: None,
                installed_at: Self::detect_path_installed_at(&target_str),
                registry_key: None,
                source_kind: Some(SourceKind::Shortcut),
            };
            covered.insert(&app);
            out.push(app);
        }
        out
    }

    /// 三棵卸载注册表根：同名同版本条目合并字段，缺 InstallLocation 时由 UninstallString
    /// 或 WiX 子组件回填。
    #[cfg(target_os = "windows")]
    fn scan_uninstall_registry() -> Vec<ScannedRawApp> {
        use std::collections::{BTreeMap, HashMap};
        use winreg::enums::*;
        use winreg::RegKey;

        let mut scanned_list: Vec<ScannedRawApp> = Vec::new();
        let mut index_by_key: HashMap<String, usize> = HashMap::new();
        let mut component_locations: BTreeMap<String, String> = BTreeMap::new();

        let targets = [
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ];

        let read = |key: &RegKey, name: &str| -> Option<String> {
            key.get_value::<String, _>(name)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            let Ok(uninstall_key) = root.open_subkey(subpath) else {
                continue;
            };
            for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                let Ok(app_key) = uninstall_key.open_subkey(&key_name) else {
                    continue;
                };
                // 系统组件或子更新：记下可能存在的实际安装路径（如 WiX MSI 载荷），然后忽略条目本身
                if app_key.get_value::<u32, _>("SystemComponent").ok() == Some(1) {
                    if let (Some(disp), Some(loc)) = (
                        read(&app_key, "DisplayName"),
                        read(&app_key, "InstallLocation"),
                    ) {
                        let loc = loc.trim_matches('"').to_string();
                        if Path::new(&loc).exists() {
                            component_locations.insert(disp.to_lowercase(), loc);
                        }
                    }
                    continue;
                }
                if read(&app_key, "ParentKeyName").is_some() {
                    continue;
                }
                let Some(display_name) = read(&app_key, "DisplayName") else {
                    continue;
                };

                // 过滤系统更新、补丁与 VC++ 依赖噪声
                let lower_name = display_name.to_lowercase();
                if lower_name.starts_with("kb")
                    && lower_name[2..].chars().all(|c| c.is_ascii_digit())
                {
                    continue;
                }
                if lower_name.contains("security update")
                    || lower_name.contains("update for windows")
                    || lower_name.contains("update for microsoft")
                    || lower_name.contains("redistributable")
                {
                    continue;
                }

                let display_version = read(&app_key, "DisplayVersion").unwrap_or_default();
                let uninstall_string = read(&app_key, "UninstallString");
                let install_location = read(&app_key, "InstallLocation").or_else(|| {
                    uninstall_string
                        .as_deref()
                        .and_then(infer_install_dir_from_uninstall_string)
                });
                let installed_at = read(&app_key, "InstallDate")
                    .as_deref()
                    .and_then(parse_install_date_to_unix)
                    .or_else(|| get_reg_key_last_write_time(&app_key));

                let app = ScannedRawApp {
                    display_name,
                    display_version: display_version.clone(),
                    publisher: read(&app_key, "Publisher"),
                    install_location,
                    display_icon: read(&app_key, "DisplayIcon"),
                    uninstall_string,
                    installed_at,
                    registry_key: registry_key_label(&key_name),
                    source_kind: Some(SourceKind::Registry),
                };

                let dedup_key = format!("{}::{}", lower_name, display_version);
                match index_by_key.get(&dedup_key) {
                    Some(&idx) => merge_missing_fields(&mut scanned_list[idx], app),
                    None => {
                        index_by_key.insert(dedup_key, scanned_list.len());
                        scanned_list.push(app);
                    }
                }
            }
        }

        for app in &mut scanned_list {
            if app.install_location.is_none() {
                app.install_location =
                    match_wix_component_location(&app.display_name, &component_locations);
            }
        }

        scanned_list
    }
}

#[cfg(test)]
mod covered_paths_tests {
    use super::{is_path_covered, CoveredPaths};
    use crate::scanner::ScannedRawApp;

    fn app(loc: Option<&str>, icon: Option<&str>) -> ScannedRawApp {
        ScannedRawApp {
            install_location: loc.map(str::to_string),
            display_icon: icon.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn covers_install_dir_descendants_and_display_icon() {
        let apps = vec![
            app(Some(r"C:\Program Files\Foo\"), None),
            app(None, Some(r#""D:\Tools\Bar\bar.exe",0"#)),
            app(Some(""), Some("")),
        ];
        let idx = CoveredPaths::from_apps(&apps);
        assert!(idx.covers(r"c:\program files\foo"));
        assert!(idx.covers(r"C:/Program Files/Foo/bin/foo.exe"));
        assert!(idx.covers(r"D:\Tools\Bar\bar.exe"));
        assert!(
            !idx.covers(r"C:\Program Files\FooBar\x.exe"),
            "同前缀兄弟目录不算覆盖"
        );
        assert!(!idx.covers(r"D:\Tools\Bar\other.exe"), "图标只按全路径命中");
        assert!(!idx.covers(r"D:\Tools"), "祖先目录不算覆盖");
        assert!(!idx.covers(""));
        assert_eq!(
            is_path_covered(r"C:\Program Files\Foo\a.exe", &apps),
            idx.covers(r"C:\Program Files\Foo\a.exe")
        );
    }

    #[test]
    fn incremental_insert_is_visible_to_later_queries() {
        let mut idx = CoveredPaths::default();
        assert!(!idx.covers(r"E:\Green\App\app.exe"));
        idx.insert(&app(Some(r"E:\Green\App"), Some(r"E:\Green\App\app.exe")));
        assert!(idx.covers(r"E:\Green\App\app.exe"));
        assert!(idx.covers(r"E:\Green\App\sub\tool.exe"));
    }
}
