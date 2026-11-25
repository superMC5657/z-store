use crate::AppState;
use std::collections::HashMap;
use tauri::State;

enum SettingDefault {
    Static(&'static str),
    FromConfig(fn(&crate::config::ProjectConfig) -> String),
}

/// 受管设置键与默认值定义表（读写白名单同源）；凭据键由 oauth 模块独立路径读写。
const MANAGED_SETTING_DEFS: &[(&str, SettingDefault)] = &[
    ("theme", SettingDefault::Static("system")),
    ("language", SettingDefault::Static("zh-CN")),
    ("ui_scale", SettingDefault::Static("100")),
    ("font_size", SettingDefault::Static("14")),
    (
        "portable_dir",
        SettingDefault::Static("%LOCALAPPDATA%\\Programs\\z-store-apps"),
    ),
    ("download_dir", SettingDefault::Static("~/Downloads")),
    ("active_mirror", SettingDefault::Static("ghproxy")),
    ("launch_on_startup", SettingDefault::Static("false")),
    ("update_frequency", SettingDefault::Static("startup")),
    (
        "detail_cache_ttl_minutes",
        SettingDefault::FromConfig(|cfg| cfg.cache.detail_ttl_minutes.to_string()),
    ),
    (
        "asset_cache_max_mb",
        SettingDefault::FromConfig(|cfg| cfg.cache.asset_max_mb.to_string()),
    ),
    (
        "asset_cache_max_files",
        SettingDefault::FromConfig(|cfg| cfg.cache.asset_max_files.to_string()),
    ),
    (
        "catalog_source_url",
        SettingDefault::FromConfig(|cfg| cfg.catalog.default_source_url.clone()),
    ),
    ("watch_notify_frequency", SettingDefault::Static("daily")),
    // 自维护 overlay 开关（默认开；关闭即隐藏全部 custom 行）。
    ("show_custom", SettingDefault::Static("true")),
    // 推荐画像的两个信号源：本地应用信息 / GitHub 用户信息。
    ("enable_local_affinity", SettingDefault::Static("true")),
    ("enable_github_affinity", SettingDefault::Static("true")),
    (
        "strict_errors",
        SettingDefault::FromConfig(|cfg| cfg.runtime.strict_errors.to_string()),
    ),
];

fn get_default_settings() -> HashMap<String, String> {
    let cfg = crate::config::get_project_config();
    let mut map = HashMap::with_capacity(MANAGED_SETTING_DEFS.len());
    for (key, default) in MANAGED_SETTING_DEFS {
        let value = match default {
            SettingDefault::Static(s) => (*s).to_string(),
            SettingDefault::FromConfig(f) => f(cfg),
        };
        map.insert((*key).to_string(), value);
    }
    map
}

fn is_managed_setting_key(key: &str) -> bool {
    MANAGED_SETTING_DEFS.iter().any(|(k, _)| *k == key)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> crate::AppResult<HashMap<String, String>> {
    let db = state.db()?;
    let db_settings = db.get_all_settings()?;

    let mut map = get_default_settings();

    for (k, v) in db_settings {
        if is_managed_setting_key(&k) && !v.trim().is_empty() {
            map.insert(k, v);
        }
    }

    Ok(map)
}

#[cfg(target_os = "windows")]
pub fn sync_launch_on_startup(enabled: bool) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_path = std::path::Path::new("Software")
        .join("Microsoft")
        .join("Windows")
        .join("CurrentVersion")
        .join("Run");

    if let Ok((key, _)) = hkcu.create_subkey_with_flags(&run_path, KEY_ALL_ACCESS) {
        if enabled {
            if let Ok(exe_path) = std::env::current_exe() {
                let cmd = format!("\"{}\"", exe_path.to_string_lossy());
                let _ = key.set_value("ZStore", &cmd);
            }
        } else {
            let _ = key.delete_value("ZStore");
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn sync_launch_on_startup(_enabled: bool) {}

/// 收录清单源校验：空串（回退默认源）、带主机且无内嵌凭据的 `http(s)://` URL、
/// `file://` 或本地路径；拒绝其它协议与 Windows 网络路径（UNC 读取会触发 SMB/NTLM 外泄）。
fn validate_catalog_source_url(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("收录清单源不得包含控制字符".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let parsed = reqwest::Url::parse(trimmed)
            .map_err(|_| format!("收录清单源不是合法 URL: {}", trimmed))?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("收录清单源不应携带用户凭据（user:pass@host 形态）".to_string());
        }
        if parsed.host_str().is_none_or(str::is_empty) {
            return Err(format!("收录清单源缺少主机名: {}", trimmed));
        }
        return Ok(());
    }
    let local = if lower.starts_with("file://") {
        &trimmed["file://".len()..]
    } else {
        // 其它 `scheme:` 形态一律拒绝；单字母 scheme 即 Windows 盘符（`C:\...`）。
        if let Some(colon) = trimmed.find(':') {
            let scheme = &trimmed[..colon];
            let looks_like_scheme = scheme.len() > 1
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
            if looks_like_scheme {
                return Err(format!("收录清单源不支持 {}: 协议", scheme));
            }
        }
        trimmed
    };
    if super::system::is_windows_network_path(local) {
        return Err(format!("收录清单源不支持网络路径: {}", trimmed));
    }
    Ok(())
}

/// 通用设置面的值校验：专用命令自带校验的键在此对齐同一口径，防止经 `save_setting` 或备份导入绕过。
pub(crate) fn validate_setting_value(key: &str, value: &str) -> Result<(), String> {
    match key {
        "active_mirror" => crate::mirror::validate_custom_proxy(value),
        "catalog_source_url" => validate_catalog_source_url(value),
        _ => Ok(()),
    }
}

/// 同步内存中的下载镜像状态（供 `save_setting` 与 `import_user_data` 共用；调用时不得持有 `state.db()` 锁）。
pub(crate) fn sync_active_mirror(state: &AppState, mirror_id: &str) {
    if let Ok(mut mirror) = state.mirror.lock() {
        let _ = mirror.set_active_mirror(mirror_id);
    }
}

/// `save_setting` 核心逻辑（拆出供单测直测状态同步）。
pub(crate) fn save_setting_inner(
    state: &AppState,
    key: &str,
    value: &str,
) -> crate::AppResult<bool> {
    if !is_managed_setting_key(key) {
        return Err(crate::AppError::new(format!("未知的设置键: {}", key)));
    }
    validate_setting_value(key, value).map_err(crate::AppError::new)?;
    let value = crate::db::normalize_setting_value(key, value);
    {
        let db = state.db()?;
        db.set_setting(key, &value)?;
    }

    if key == "launch_on_startup" {
        let enabled = value == "true" || value == "1";
        sync_launch_on_startup(enabled);
    } else if key == "active_mirror" {
        sync_active_mirror(state, &value);
    } else if key == "enable_local_affinity" || key == "enable_github_affinity" {
        crate::notify_affinity_updated();
    }

    Ok(true)
}

#[tauri::command]
pub fn save_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> crate::AppResult<bool> {
    save_setting_inner(&state, &key, &value)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn select_folder(
    default_path: Option<String>,
    title: Option<String>,
) -> crate::AppResult<Option<String>> {
    let res = tokio::task::spawn_blocking(move || {
        let dialog_title = title.unwrap_or_else(|| "选择目录".to_string());
        let mut dialog = rfd::FileDialog::new().set_title(&dialog_title);
        if let Some(ref path_str) = default_path {
            let expanded = crate::installer::expand_env_path(path_str);
            if expanded.exists() {
                dialog = dialog.set_directory(&expanded);
            }
        }
        let folder = dialog.pick_folder();
        folder.map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| crate::AppError::new(e.to_string()))?;
    Ok(res)
}

#[cfg(test)]
mod setting_gate_tests {
    use super::{
        get_default_settings, is_managed_setting_key, validate_setting_value, MANAGED_SETTING_DEFS,
    };

    #[test]
    fn active_mirror_via_save_setting_requires_https() {
        for ok in ["", "direct", "ghproxy", "https://gh-proxy.com"] {
            assert!(
                validate_setting_value("active_mirror", ok).is_ok(),
                "{ok:?}"
            );
        }
        for bad in [
            "http://gh-proxy.com",
            "https://127.0.0.1",
            "https://user:pw@gh-proxy.com",
            "ftp://mirror.example.com",
        ] {
            assert!(
                validate_setting_value("active_mirror", bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn catalog_source_url_rejects_dangerous_forms() {
        for ok in [
            "",
            "https://example.com/catalog.json",
            "HTTP://localhost:8080/catalog.json",
            "file:///C:/data/catalog.json",
            r"C:\data\catalog.json",
            "/home/me/catalog.json",
            "catalog.json",
        ] {
            assert!(
                validate_setting_value("catalog_source_url", ok).is_ok(),
                "{ok:?} must be accepted"
            );
        }
        for bad in [
            r"\\attacker\share\catalog.json",
            "//attacker/share/catalog.json",
            "file:////attacker/share/catalog.json",
            r"file://\\attacker\share\catalog.json",
            "smb://attacker/share",
            "javascript:alert(1)",
            "https://user:pw@example.com/c.json",
            "https://",
            "https://example.com/\u{0}x",
        ] {
            assert!(
                validate_setting_value("catalog_source_url", bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn other_keys_are_not_value_validated() {
        assert!(validate_setting_value("theme", "anything").is_ok());
    }

    #[test]
    fn ui_setting_keys_pass_gate() {
        // 白名单与默认键集同源：全部默认键必然放行（抽 commonly written 的代表）。
        for key in [
            "theme",
            "language",
            "ui_scale",
            "font_size",
            "portable_dir",
            "download_dir",
            "active_mirror",
            "launch_on_startup",
            "update_frequency",
            "detail_cache_ttl_minutes",
            "catalog_source_url",
            "watch_notify_frequency",
            "show_custom",
            "enable_local_affinity",
            "enable_github_affinity",
            "strict_errors",
        ] {
            assert!(is_managed_setting_key(key), "{} 应当在白名单内", key);
        }
    }

    #[test]
    fn managed_keys_match_default_settings_exactly() {
        use std::collections::BTreeSet;
        let defaults = get_default_settings();
        let from_defaults: BTreeSet<&str> = defaults.keys().map(String::as_str).collect();
        let managed: BTreeSet<&str> = MANAGED_SETTING_DEFS.iter().map(|(k, _)| *k).collect();
        assert_eq!(managed.len(), MANAGED_SETTING_DEFS.len(), "白名单含重复键");
        assert_eq!(managed, from_defaults);
    }

    #[test]
    fn credential_and_foreign_keys_rejected() {
        // 凭据/用户键不得经通用设置面写读；任意其他键同样拒绝。
        for key in [
            "github_oauth_token",
            "github_oauth_user",
            "github_oauth_client_id",
            "github_token",
            "",
            "theme; DROP TABLE user_settings",
        ] {
            assert!(!is_managed_setting_key(key), "{} 应当被白名单拒绝", key);
        }
    }

    #[test]
    fn save_setting_active_mirror_syncs_in_memory_mirror_manager() {
        let state = crate::AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(
                crate::db::Database::open_in_memory().unwrap(),
            )),
            catalog: crate::github::CatalogService::with_items(vec![]),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        };
        assert_eq!(state.mirror.lock().unwrap().active_mirror_prefix(), None);
        super::save_setting_inner(&state, "active_mirror", "ghproxy").unwrap();
        assert_eq!(
            state.mirror.lock().unwrap().active_mirror_prefix().as_deref(),
            Some(crate::mirror::DEFAULT_GH_PROXY)
        );
        assert_eq!(
            state
                .db()
                .unwrap()
                .get_setting("active_mirror")
                .unwrap()
                .as_deref(),
            Some("ghproxy")
        );
        super::save_setting_inner(&state, "active_mirror", "https://mirror.example.com").unwrap();
        assert_eq!(
            state.mirror.lock().unwrap().active_mirror_prefix().as_deref(),
            Some("https://mirror.example.com")
        );
        super::save_setting_inner(&state, "active_mirror", "direct").unwrap();
        assert_eq!(state.mirror.lock().unwrap().active_mirror_prefix(), None);
    }
}
