pub mod commands;
pub mod db;
pub mod github;
pub mod installer;
pub mod mirror;
pub mod models;
pub mod scanner;
pub mod verifier;

use db::Database;
use github::CatalogService;
use mirror::MirrorManager;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Database>,
    pub catalog: CatalogService,
    pub mirror: Mutex<MirrorManager>,
    pub github_token: Mutex<Option<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_data_dir = std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let db_dir = app_data_dir.join("ZStore");
    let _ = std::fs::create_dir_all(&db_dir);
    let db_path = db_dir.join("z_store.db");

    let db = Database::open(&db_path)
        .or_else(|_| Database::open_in_memory())
        .expect("failed to init database");

    let saved_token = db
        .get_setting("github_token")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let saved_mirror = db.get_setting("active_mirror").ok().flatten();

    let catalog = CatalogService::new();
    let mut mirror = MirrorManager::new();
    if let Some(ref m_id) = saved_mirror {
        mirror.set_active_mirror(m_id);
    }

    let state = AppState {
        db: Mutex::new(db),
        catalog,
        mirror: Mutex::new(mirror),
        github_token: Mutex::new(saved_token),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::search_apps,
            commands::get_app_details,
            commands::get_installed_apps,
            commands::install_app,
            commands::uninstall_app,
            commands::check_for_updates,
            commands::get_mirror_status,
            commands::switch_mirror,
            commands::set_github_token,
            commands::get_settings,
            commands::save_setting,
            commands::get_favorites,
            commands::toggle_favorite,
            commands::clear_cache,
            commands::ping_mirrors,
            commands::get_app_readme,
            commands::get_catalog_count,
            commands::scan_and_match_local_apps,
            commands::import_matched_apps,
            commands::launch_app,
            commands::get_update_rules,
            commands::set_app_skip_version,
            commands::set_app_frozen,
            commands::set_app_hidden,
            commands::remove_update_rule,
            commands::verify_file_signature,
            commands::get_developer_profile,
            commands::sync_github_starred,
            commands::record_search_query,
            commands::get_search_history,
            commands::clear_search_history,
            commands::remove_search_query,
            commands::record_app_view,
            commands::get_recently_viewed_apps,
            commands::clear_view_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
