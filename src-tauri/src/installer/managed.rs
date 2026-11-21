//! 已纳管应用（`InstalledApp`）生命周期：盘点自愈、启动路径解析，以及安装/导入/卸载/规则变更后
//! `update_results` 判定快照的统一对齐。命令层只做参数校验与结果映射。

use crate::db::Database;
use crate::models::{InstalledApp, UpdateRule};
use crate::{AppResult, AppState};

/// 判断 `latest` 是否严格高于 `current`（SemVer 优先，4 段纯数字末段为 0 视为 3 段，2 段纯数字补 `.0`）。
/// 仅两侧都不可解析为 SemVer 时退化为归一化字符串不等；单侧不可解析返回 `false` 以防误报。
pub fn is_version_newer(current: &str, latest: &str) -> bool {
    /// 归一化：去 `v` 前缀与空白；4 段式纯数字 MSI 且末段为 0 时截断为 3 段；
    /// 无后缀的 2 段纯数字（`0.16`、`10.38`）补成 3 段，以便与 PE 版本资源的 `0.15.0` 比较。
    fn normalize(s: &str) -> String {
        let clean = s.trim_start_matches('v').trim();
        let parts: Vec<&str> = clean.split('.').collect();
        if parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.bytes().all(|b| b.is_ascii_digit())
                    && (p.len() == 1 || !p.starts_with('0'))
            })
        {
            return format!("{}.{}.0", parts[0], parts[1]);
        }
        if parts.len() == 4
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            && parts[3].trim_start_matches('0').is_empty()
        {
            return parts[..3].join(".");
        }
        clean.to_string()
    }

    let cur = normalize(current);
    let lat = normalize(latest);
    match (semver::Version::parse(&cur), semver::Version::parse(&lat)) {
        (Ok(c), Ok(l)) => l > c,
        (Err(_), Err(_)) => cur != lat,
        _ => false,
    }
}

/// 判断是否应提示此更新（应用冻结与跳过版本规则；隐藏应用仍保留以便规则管理跳过版本）。
pub fn should_include_update(
    current_version: &str,
    latest_version: &str,
    rule: Option<&UpdateRule>,
) -> bool {
    if let Some(r) = rule {
        if r.is_frozen {
            return false;
        }
        if let Some(ref skipped) = r.skipped_version {
            let clean_skipped = skipped.trim_start_matches('v').trim();
            let clean_latest = latest_version.trim_start_matches('v').trim();
            if clean_skipped == clean_latest {
                return false;
            }
        }
    }
    is_version_newer(current_version, latest_version)
}

/// 用上次查到的远端版本按给定本地版本与当前规则重算判定行；无判定行或版本未知时删行，等下次检查。
fn rebase_cached_update(db: &Database, app_id: &str, version: &str) {
    let latest = db
        .get_cached_update_version(app_id)
        .ok()
        .flatten()
        .map(|(latest, _)| latest);
    match latest {
        Some(latest) if !version.trim().is_empty() => {
            let rule = db.get_rule(app_id).ok().flatten();
            let has_update = should_include_update(version, &latest, rule.as_ref());
            let _ = db.rebase_update_result(app_id, version, has_update);
        }
        _ => {
            let _ = db.remove_update_result(app_id);
        }
    }
}

/// 规则变更后按已安装版本对齐判定行（未安装即删行）。
fn realign_update_result(db: &Database, app_id: &str) {
    let installed = db.get_installed_app(app_id).ok().flatten();
    let version = installed.map(|a| a.version).unwrap_or_default();
    rebase_cached_update(db, app_id, &version);
}

/// 记录安装或纳管导入：新版本即当前，旧判定行过期删除（下次检查重建）。
pub fn record_installed(db: &Database, app: &InstalledApp) -> rusqlite::Result<()> {
    db.save_installed_app(app)?;
    let _ = db.remove_update_result(&app.app_id);
    Ok(())
}

/// 卸载或取消纳管：删除安装记录，命中时同步删除判定行；返回是否命中。
pub fn remove_managed(db: &Database, app_id: &str) -> rusqlite::Result<bool> {
    let hit = db.remove_installed_app(app_id)?;
    if hit {
        let _ = db.remove_update_result(app_id);
    }
    Ok(hit)
}

/// 设置跳过版本并对齐判定行。
pub fn set_app_skip_version(
    db: &Database,
    app_id: &str,
    version: Option<&str>,
) -> rusqlite::Result<()> {
    db.set_skip_version(app_id, version)?;
    realign_update_result(db, app_id);
    Ok(())
}

/// 设置冻结状态并对齐判定行。
pub fn set_app_frozen(db: &Database, app_id: &str, is_frozen: bool) -> rusqlite::Result<()> {
    db.set_frozen_status(app_id, is_frozen)?;
    realign_update_result(db, app_id);
    Ok(())
}

/// 设置隐藏状态并对齐判定行。
pub fn set_app_hidden(db: &Database, app_id: &str, is_hidden: bool) -> rusqlite::Result<()> {
    db.set_hidden_status(app_id, is_hidden)?;
    realign_update_result(db, app_id);
    Ok(())
}

/// 启动时探测到真实路径与记录不同则回写（加速下次启动）；仅路径变化，判定行不受影响。
fn backfill_install_path(
    state: &AppState,
    installed: &Option<InstalledApp>,
    recorded: &str,
    found: &str,
) {
    let Some(mut updated) = installed.clone() else {
        return;
    };
    if recorded == found {
        return;
    }
    if let Ok(db) = state.db() {
        updated.install_path = found.to_string();
        let _ = db.save_installed_app(&updated);
    }
}

/// 盘点自愈产物：刷新后的列表、需回写的行、版本被更正的应用与幽灵应用。
struct InstalledRefresh {
    apps: Vec<InstalledApp>,
    updated: Vec<InstalledApp>,
    /// 本地版本被更正的应用：(app_id, 新版本)，其判定行按新版本重算
    corrected_versions: Vec<(String, String)>,
    ghost_app_ids: Vec<String>,
}

/// 已安装应用列表（含路径自愈、导入版本更正与幽灵隐藏）：
/// 短锁读库 → 阻塞线程池做注册表枚举与文件系统探测 → 有变更时再取短锁回写。
pub async fn load_installed_apps(state: &AppState) -> AppResult<Vec<InstalledApp>> {
    let mut apps = {
        let db = state.db()?;
        db.get_installed_apps().map_err(|e| e.to_string())?
    };
    fill_installed_icons(state, &mut apps);

    let refresh = super::run_blocking(move || refresh_installed_apps(apps)).await?;
    {
        let db = state.db()?;
        apply_refresh_writes(&db, &refresh);
    }
    // 只读扫描不删除数据库记录，幽灵应用仅在返回视图中隐藏。
    if !refresh.ghost_app_ids.is_empty() {
        let mut ev = crate::z_log::WideEvent::new("scanner", "ghosts hidden");
        ev.field("count", refresh.ghost_app_ids.len());
        ev.warn();
    }
    Ok(hide_ghost_apps(refresh.apps, &refresh.ghost_app_ids))
}

/// 自愈结果回写：变更行落库，版本被更正的应用按新版本重算判定行。
fn apply_refresh_writes(db: &Database, refresh: &InstalledRefresh) {
    for updated in &refresh.updated {
        let _ = db.save_installed_app(updated);
    }
    for (app_id, version) in &refresh.corrected_versions {
        rebase_cached_update(db, app_id, version);
    }
}

/// 从返回视图中过滤幽灵应用，同时保留数据库记录。
pub(crate) fn hide_ghost_apps(apps: Vec<InstalledApp>, ghost_ids: &[String]) -> Vec<InstalledApp> {
    apps.into_iter()
        .filter(|a| !ghost_ids.iter().any(|g| g == &a.app_id))
        .collect()
}

/// 图标补全：收录项取目录官方图标，其余取 `app_details` 摘要（单次分片查询，不读 README 等大字段）。
fn fill_installed_icons(state: &AppState, apps: &mut [InstalledApp]) {
    let mut detail_ids: Vec<String> = Vec::new();
    for app in apps.iter_mut().filter(|a| a.icon.is_none()) {
        if let Some(item) = state.catalog.get_catalog_item(&app.app_id) {
            app.icon = Some(item.icon);
            app.icon_bg = Some(item.icon_bg);
        } else {
            detail_ids.push(app.app_id.clone());
        }
    }
    if detail_ids.is_empty() {
        return;
    }
    let details = match state.db() {
        Ok(db) => db
            .get_app_detail_summaries_batch(&detail_ids, false)
            .unwrap_or_default(),
        Err(_) => return,
    };
    for app in apps.iter_mut().filter(|a| a.icon.is_none()) {
        let Some(detail) = details.get(app.app_id.trim()) else {
            continue;
        };
        if !detail.core.icon.trim().is_empty() {
            app.icon = Some(detail.core.icon.clone());
        }
        if !detail.core.icon_bg.trim().is_empty() {
            app.icon_bg = Some(detail.core.icon_bg.clone());
        }
    }
}

/// 路径自愈、导入版本与安装时间更正（零 DB；注册表只在有导入应用时枚举一次）。
fn refresh_installed_apps(mut apps: Vec<InstalledApp>) -> InstalledRefresh {
    let mut updated = Vec::new();
    let mut corrected_versions: Vec<(String, String)> = Vec::new();
    let mut ghost_app_ids = Vec::new();
    let mut registry_entries: Option<Vec<crate::scanner::ScannedRawApp>> = None;

    for app in &mut apps {
        let mut app_changed = false;
        let is_empty = app.install_path.trim().is_empty();
        let not_exist = !is_empty && !std::path::Path::new(&app.install_path).exists();
        if is_empty || not_exist {
            if let Some(repaired_path) = crate::scanner::AppScanner::resolve_installed_app_path(
                &app.app_name,
                &app.app_id,
                None,
            ) {
                app.install_path = repaired_path.clone();
                if app.uninstall_command.is_none() {
                    // 本轮已枚举过注册表（存在系统导入应用）时复用，不再逐个应用重扫卸载表。
                    app.uninstall_command = super::paths::resolve_uninstaller_command_in(
                        &app.app_name,
                        &app.app_id,
                        &repaired_path,
                        None,
                        registry_entries.as_deref(),
                    );
                }
                app_changed = true;
            } else {
                // 原路径失效且全盘嗅探找不到主程序：已被外部渠道卸载，视图中隐藏。
                ghost_app_ids.push(app.app_id.clone());
            }
        }

        // 版本来源是 Windows 注册表；其他平台的导入版本不在此刷新
        if cfg!(target_os = "windows") && app.install_method == "system_import" {
            let entries =
                registry_entries.get_or_insert_with(crate::scanner::AppScanner::scan_system_apps);
            if let Some(detected) = crate::scanner::AppScanner::detect_installed_version(
                entries,
                &app.install_path,
                crate::scanner::AppScanner::read_exe_version,
            ) {
                if !crate::scanner::version::same_version(&detected, &app.version) {
                    corrected_versions.push((app.app_id.clone(), detected.clone()));
                    app.version = detected;
                    app_changed = true;
                }
            }
        }

        // 导入路径只盖当前时刻，此处按可执行文件反查真实安装时间（Windows 复用本轮注册表条目）。
        if app.install_method == "system_import" {
            let detected = if cfg!(target_os = "windows") {
                let entries = registry_entries
                    .get_or_insert_with(crate::scanner::AppScanner::scan_system_apps);
                crate::scanner::AppScanner::detect_installed_at_from_entries(
                    entries,
                    &app.install_path,
                )
            } else {
                crate::scanner::AppScanner::detect_path_installed_at(&app.install_path)
            };
            if let Some(real_time) = detected {
                if real_time != app.installed_at && real_time > 0 {
                    app.installed_at = real_time;
                    app_changed = true;
                }
            }
        }

        if app_changed {
            updated.push(app.clone());
        }
    }

    InstalledRefresh {
        apps,
        updated,
        corrected_versions,
        ghost_app_ids,
    }
}

fn spawn_in_parent_dir(exe_path: &std::path::Path, err_ctx: &str) -> Result<(), String> {
    let parent = exe_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    std::process::Command::new(exe_path)
        .current_dir(parent)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {}", err_ctx, e))
}

/// 解析并启动应用主程序（阻塞；须在阻塞线程池调用）：记录路径直启 → 真实路径探测 →
/// 便携目录 → Windows 桌面快捷方式 → Linux desktop Exec / PATH；探测命中的新路径回写记录。
pub fn launch_installed_app(state: &AppState, app_id: &str) -> AppResult<bool> {
    let installed_app_opt = {
        let db = state.db()?;
        db.get_installed_app(app_id).map_err(|e| e.to_string())?
    };

    let (app_name, target_path, catalog_repo) = if let Some(ref app) = installed_app_opt {
        (
            app.app_name.clone(),
            app.install_path.trim().trim_matches('"').to_string(),
            None,
        )
    } else if let Some(c) = state.catalog.get_catalog_item(app_id) {
        let p =
            crate::scanner::AppScanner::resolve_installed_app_path(&c.name, &c.id, Some(&c.repo))
                .unwrap_or_default();
        (c.name, p, Some(c.repo))
    } else {
        return Err(format!("未找到已安装或管理的应用: {}", app_id).into());
    };

    let path_obj = std::path::Path::new(&target_path);
    let lower = target_path.to_lowercase();
    // 临时下载目录中的安装包不直启，避免误重新调起安装向导。
    let is_temp_installer = lower.contains(r"\temp\")
        || lower.contains(r"/temp/")
        || [
            "-setup.exe",
            "_setup.exe",
            "-installer.exe",
            ".msi",
            ".dmg",
            ".deb",
            ".rpm",
        ]
        .iter()
        .any(|suffix| lower.ends_with(suffix));

    if !is_temp_installer {
        #[cfg(target_os = "macos")]
        if path_obj.exists()
            && ((path_obj.is_dir() && target_path.ends_with(".app")) || path_obj.is_file())
        {
            std::process::Command::new("open")
                .arg(&target_path)
                .spawn()
                .map_err(|e| format!("启动 macOS 应用程序失败: {}", e))?;
            return Ok(true);
        }

        if path_obj.is_file() {
            let ext = path_obj
                .extension()
                .map_or("", |e| e.to_str().unwrap_or(""));
            if ext.eq_ignore_ascii_case("lnk") {
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer.exe")
                        .arg(&target_path)
                        .spawn()
                        .map_err(|e| format!("调起快捷方式失败: {}", e))?;
                    return Ok(true);
                }
            } else if ext.eq_ignore_ascii_case("exe") {
                spawn_in_parent_dir(path_obj, "启动应用程序失败")?;
                return Ok(true);
            } else {
                // .desktop 交给下方 Exec 解析直启，不把桌面文件当二进制执行。
                #[cfg(target_os = "linux")]
                {
                    if !ext.eq_ignore_ascii_case("desktop") {
                        let _ = std::process::Command::new("chmod")
                            .arg("+x")
                            .arg(path_obj)
                            .status();
                        spawn_in_parent_dir(path_obj, "启动 Linux 应用程序失败")?;
                        return Ok(true);
                    }
                }
            }
        }
    }

    // 探测真实可执行路径
    let candidate_exe = crate::scanner::AppScanner::resolve_installed_app_path(
        &app_name,
        app_id,
        catalog_repo.as_deref(),
    )
    .or_else(|| {
        crate::scanner::AppScanner::resolve_executable_path(
            if target_path.is_empty() {
                None
            } else {
                Some(&target_path)
            },
            None,
            &app_name,
        )
    });
    if let Some(exe_str) = candidate_exe {
        let exe_path = std::path::Path::new(&exe_str);
        if exe_path.is_file() {
            spawn_in_parent_dir(exe_path, "启动应用程序失败")?;
            backfill_install_path(state, &installed_app_opt, &target_path, &exe_str);
            return Ok(true);
        }
    }

    // 便携应用目录
    let portable_dir = super::dirs_or_fallback(app_id);
    if portable_dir.is_dir() {
        if let Some(exe_str) = crate::scanner::AppScanner::resolve_executable_path(
            Some(&portable_dir.to_string_lossy()),
            None,
            &app_name,
        ) {
            let exe_path = std::path::Path::new(&exe_str);
            if exe_path.is_file() {
                spawn_in_parent_dir(exe_path, "启动便携版失败")?;
                return Ok(true);
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(lnk) = super::paths::find_desktop_shortcut(&app_name, app_id) {
        std::process::Command::new("explorer.exe")
            .arg(lnk.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("通过快捷方式启动失败: {}", e))?;
        return Ok(true);
    }

    // Linux 兜底：desktop Exec 或 PATH 查找并启动。
    #[cfg(target_os = "linux")]
    {
        let catalog_ids = state
            .catalog
            .get_catalog_item(app_id)
            .map(|cat| cat.get_native_identifiers())
            .unwrap_or_default();
        let (_, bare_names) = crate::scanner::AppScanner::linux_candidate_names(
            &catalog_ids,
            &[app_name.clone(), app_id.to_string()],
        );
        for found in super::paths::linux_binary_candidates(&bare_names) {
            let exe_path = std::path::Path::new(&found);
            if !exe_path.is_file() {
                continue;
            }
            spawn_in_parent_dir(exe_path, &format!("启动失败 ({})", found))?;
            backfill_install_path(state, &installed_app_opt, &target_path, &found);
            return Ok(true);
        }

        // 记录路径为空时给出可排查的候选路径。
        if target_path.is_empty() {
            let hints: Vec<String> = [app_name.as_str(), app_id]
                .into_iter()
                .filter_map(|cand| {
                    let base = cand
                        .rsplit('/')
                        .next()
                        .unwrap_or(cand)
                        .trim()
                        .to_lowercase();
                    let p = std::path::PathBuf::from("/usr/bin").join(&base);
                    (base.len() >= 2 && p.is_file()).then(|| p.to_string_lossy().to_string())
                })
                .collect();
            let hint_text = if hints.is_empty() {
                "（已尝试 PATH/which、/usr/bin/<名称>、/opt/<名称>/* 与 *.desktop Exec，均未命中）"
                    .to_string()
            } else {
                format!("（发现候选: {}，但嗅探未通过校验）", hints.join(", "))
            };
            return Err(format!(
                "未能定位到该软件的可执行程序。\n记录路径: 无 {}\n应用: {} ({})\n建议检查软件是否已被重命名或移动位置，或重新扫描添加。",
                hint_text, app_name, app_id
            ).into());
        }
    }

    Err(format!(
        "未能定位到该软件的可执行程序。\n记录路径: {}\n建议检查软件是否已被重命名或移动位置，或重新扫描添加。",
        if target_path.is_empty() { "无" } else { &target_path }
    ).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn sample_app(id: &str, version: &str) -> InstalledApp {
        InstalledApp {
            app_id: id.to_string(),
            app_name: format!("{}-name", id),
            version: version.to_string(),
            installed_at: 0,
            install_method: "portable_zip".to_string(),
            install_path: String::new(),
            asset_name: "a.zip".to_string(),
            asset_sha256: "x".to_string(),
            uninstall_command: None,
            icon: None,
            icon_bg: None,
        }
    }

    fn seed_update_row(db: &Database, id: &str, installed: &str, latest: &str, has_update: bool) {
        db.save_update_check(&crate::db::UpdateCheckRow {
            app_id: id.to_string(),
            app_name: format!("{id}-name"),
            installed_version: installed.to_string(),
            latest_version: latest.to_string(),
            has_update,
            changelog: "notes".to_string(),
            icon: None,
            icon_bg: None,
            checked_at: 1,
        })
        .unwrap();
    }

    fn has_update(db: &Database, id: &str) -> Option<bool> {
        db.query_scalar_opt::<i64, _>(
            "SELECT has_update FROM update_results WHERE app_id = ?1",
            [id],
        )
        .unwrap()
        .map(|v| v != 0)
    }

    #[test]
    fn record_installed_saves_app_and_drops_stale_update_row() {
        let db = Database::open_in_memory().unwrap();
        seed_update_row(&db, "o/a", "1.0.0", "1.1.0", true);

        record_installed(&db, &sample_app("o/a", "1.1.0")).unwrap();

        assert_eq!(
            db.get_installed_app("o/a").unwrap().unwrap().version,
            "1.1.0"
        );
        assert_eq!(has_update(&db, "o/a"), None);
    }

    #[test]
    fn remove_managed_drops_record_and_update_row_only_on_hit() {
        let db = Database::open_in_memory().unwrap();
        record_installed(&db, &sample_app("o/a", "1.0.0")).unwrap();
        seed_update_row(&db, "o/a", "1.0.0", "1.1.0", true);
        seed_update_row(&db, "o/orphan", "1.0.0", "1.1.0", true);

        assert!(remove_managed(&db, "o/a").unwrap());
        assert!(db.get_installed_app("o/a").unwrap().is_none());
        assert_eq!(has_update(&db, "o/a"), None);

        assert!(!remove_managed(&db, "o/orphan").unwrap());
        assert_eq!(has_update(&db, "o/orphan"), Some(true));
    }

    #[test]
    fn rule_changes_realign_cached_update_snapshot() {
        let db = Database::open_in_memory().unwrap();
        record_installed(&db, &sample_app("o/a", "1.0.0")).unwrap();
        seed_update_row(&db, "o/a", "1.0.0", "v1.1.0", true);

        set_app_frozen(&db, "o/a", true).unwrap();
        assert_eq!(has_update(&db, "o/a"), Some(false));
        set_app_frozen(&db, "o/a", false).unwrap();
        assert_eq!(has_update(&db, "o/a"), Some(true));

        set_app_skip_version(&db, "o/a", Some("1.1.0")).unwrap();
        assert_eq!(has_update(&db, "o/a"), Some(false));
        set_app_skip_version(&db, "o/a", None).unwrap();
        assert_eq!(has_update(&db, "o/a"), Some(true));

        // 隐藏不影响判定（供「已隐藏」签管理跳过版本）。
        set_app_hidden(&db, "o/a", true).unwrap();
        assert_eq!(has_update(&db, "o/a"), Some(true));
        assert!(db.get_rule("o/a").unwrap().unwrap().is_hidden);
    }

    #[test]
    fn rule_change_for_uninstalled_app_drops_orphan_snapshot() {
        let db = Database::open_in_memory().unwrap();
        seed_update_row(&db, "o/gone", "1.0.0", "1.1.0", true);

        set_app_frozen(&db, "o/gone", false).unwrap();

        assert_eq!(has_update(&db, "o/gone"), None);
    }

    #[test]
    fn refresh_writes_persist_rows_and_rebase_corrected_versions() {
        let db = Database::open_in_memory().unwrap();
        record_installed(&db, &sample_app("o/a", "1.0.0")).unwrap();
        record_installed(&db, &sample_app("o/b", "1.0.0")).unwrap();
        seed_update_row(&db, "o/a", "1.0.0", "1.2.0", true);
        let mut healed = sample_app("o/b", "1.0.0");
        healed.install_path = "C:\\healed\\b.exe".to_string();

        apply_refresh_writes(
            &db,
            &InstalledRefresh {
                apps: Vec::new(),
                updated: vec![sample_app("o/a", "1.2.0"), healed],
                corrected_versions: vec![("o/a".to_string(), "1.2.0".to_string())],
                ghost_app_ids: Vec::new(),
            },
        );

        assert_eq!(
            db.get_installed_app("o/a").unwrap().unwrap().version,
            "1.2.0"
        );
        assert_eq!(has_update(&db, "o/a"), Some(false));
        assert_eq!(
            db.get_installed_app("o/b").unwrap().unwrap().install_path,
            "C:\\healed\\b.exe"
        );
    }

    #[test]
    fn hide_ghost_apps_filters_view_only() {
        let apps = vec![
            sample_app("owner/healthy", "1"),
            sample_app("owner/ghost", "1"),
        ];
        let out = hide_ghost_apps(apps.clone(), &["owner/ghost".to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].app_id, "owner/healthy");
        assert_eq!(hide_ghost_apps(apps, &[]).len(), 2);
    }
}
