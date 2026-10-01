use crate::models::{DownloadProgressPayload, ReleaseAsset};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadAssetResult {
    pub file_path: String,
    pub file_name: String,
    pub dir: String,
    pub sha256: String,
    pub verified: bool,
}

pub(crate) fn resolve_download_dir(state: &AppState) -> Option<std::path::PathBuf> {
    if let Ok(db) = state.db() {
        if let Ok(Some(s)) = db.get_setting("download_dir") {
            let t = s.trim();
            if !t.is_empty() {
                return Some(crate::installer::expand_env_path(t));
            }
        }
    }
    None
}

/// 安装与仅下载共用的下载通道：镜像改写 + 流式下载 + SHA-256 校验 + 进度事件，
/// 直连失败且为 GitHub 官方链接时自动切换公共加速镜像重试。
/// `init_log_tag` / `fallback_log_tag` 仅区分日志来源（`download init` / `download-only init`）。
pub(crate) async fn download_asset_with_fallback(
    app_handle: &AppHandle,
    state: &AppState,
    app_id: &str,
    asset: &ReleaseAsset,
    custom_download_dir: Option<&std::path::Path>,
    init_log_tag: &str,
    fallback_log_tag: &str,
) -> Result<(std::path::PathBuf, String), String> {
    let (rewritten_url, is_mirror) = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        let rewritten = mirror.rewrite_download_url(&asset.download_url);
        let is_mirror = rewritten != asset.download_url;
        (rewritten, is_mirror)
    };

    log::info!(
        "{} sid={} id={} file='{}' raw_url='{}' effective_url='{}' mirror={}",
        init_log_tag,
        crate::z_log::new_session_id(),
        app_id,
        asset.name,
        crate::log_support::sanitize_url(&asset.download_url),
        crate::log_support::sanitize_url(&rewritten_url),
        is_mirror
    );

    let download_res = super::InstallerEngine::download_with_progress(
        app_handle,
        app_id,
        &rewritten_url,
        &asset.name,
        asset.sha256.as_deref(),
        custom_download_dir,
    )
    .await;

    match download_res {
        Ok(ok) => Ok(ok),
        Err(e) => {
            let is_github = crate::mirror::is_github_domain(&asset.download_url);
            let is_direct = rewritten_url == asset.download_url;
            if is_github && is_direct {
                let fallback_url = crate::mirror::wrap_gh_proxy(&asset.download_url);
                log::warn!(
                    "{} url='{}'",
                    fallback_log_tag,
                    crate::log_support::sanitize_url(&fallback_url)
                );
                DownloadProgressPayload::emit_event(
                    app_handle,
                    app_id,
                    0,
                    0,
                    0,
                    "downloading",
                    Some("直连通道不稳定，正在切换公共加速镜像自动重试...".to_string()),
                );
                super::InstallerEngine::download_with_progress(
                    app_handle,
                    app_id,
                    &fallback_url,
                    &asset.name,
                    asset.sha256.as_deref(),
                    custom_download_dir,
                )
                .await
                .map_err(|fallback_err| {
                    format!("下载失败（直连: {}；镜像重试: {}）", e, fallback_err)
                })
            } else {
                Err(e)
            }
        }
    }
}

pub(crate) struct PreparedDownload {
    pub detail: crate::models::AppDetail,
    pub asset: ReleaseAsset,
    pub dest_path: std::path::PathBuf,
    pub actual_sha256: String,
}

pub(crate) async fn prepare_and_download_asset(
    app_handle: &AppHandle,
    state: &State<'_, AppState>,
    app_id: &str,
    asset_name: Option<&str>,
    missing_asset_err: &str,
    init_log_tag: &str,
    fallback_log_tag: &str,
) -> Result<PreparedDownload, String> {
    let custom_download_dir = resolve_download_dir(state);
    let detail = super::catalog::get_app_details(state.clone(), app_id.to_string(), None).await?;

    let selected_asset = if let Some(target_name) = asset_name {
        detail.releases.iter().find(|r| r.name == target_name).cloned()
    } else {
        None
    };

    let asset = selected_asset
        .or_else(|| super::select_best_asset(&detail.releases).cloned())
        .ok_or_else(|| missing_asset_err.to_string())?;

    let (dest_path, actual_sha256) = download_asset_with_fallback(
        app_handle,
        state,
        app_id,
        &asset,
        custom_download_dir.as_deref(),
        init_log_tag,
        fallback_log_tag,
    )
    .await?;

    Ok(PreparedDownload {
        detail,
        asset,
        dest_path,
        actual_sha256,
    })
}

/// 仅下载：复用安装通道的镜像改写 + 流式下载 + SHA-256 校验 + 进度事件，
/// 但不调用任何安装器。文件落盘至用户配置的下载目录，前端展示进度并提供“打开所在文件夹”。
#[tauri::command]
pub async fn download_asset(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
) -> crate::AppResult<DownloadAssetResult> {
    let app_id = super::require_app_id(&app_id)?;

    let prep = prepare_and_download_asset(
        &app_handle,
        &state,
        &app_id,
        asset_name.as_deref(),
        "该 Release 未提供可下载的产物资产",
        "download-only init",
        "download-only direct failed, retrying via fallback mirror",
    )
    .await?;

    let verified = prep
        .asset
        .sha256
        .as_deref()
        .map(|s| crate::verify_sha256_str(&prep.actual_sha256, s))
        .unwrap_or(false);
    let file_name = prep
        .dest_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| prep.asset.name.clone());
    let dir = prep
        .dest_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(DownloadAssetResult {
        file_path: prep.dest_path.to_string_lossy().to_string(),
        file_name,
        dir,
        sha256: prep.actual_sha256,
        verified,
    })
}

/// 在系统文件管理器中选中已下载的文件（Windows 资源管理器 /select，macOS 访达 -R，Linux 打开父目录）。
#[tauri::command]
pub fn show_file_in_folder(path: String) -> crate::AppResult<bool> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(crate::AppError::new("文件路径为空"));
    }
    Ok(super::system::open_desktop_path(std::path::Path::new(trimmed), true)?)
}

/// 直接打开目录（若传入文件路径则打开其父目录）。
#[tauri::command]
pub fn open_folder(path: String) -> crate::AppResult<bool> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(crate::AppError::new("目录路径为空"));
    }
    Ok(super::system::open_desktop_path(std::path::Path::new(trimmed), false)?)
}
