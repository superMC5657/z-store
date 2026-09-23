use crate::models::{DownloadProgressPayload, ReleaseAsset};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadAssetResult {
    pub file_path: String,
    pub file_name: String,
    pub dir: String,
    pub sha256: String,
    pub verified: bool,
}

pub(crate) fn resolve_download_dir(state: &AppState) -> Option<std::path::PathBuf> {
    if let Ok(db) = state.db.lock() {
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
            let is_github = asset.download_url.contains("github.com");
            let is_direct = rewritten_url == asset.download_url;
            if is_github && is_direct {
                let fallback_url = format!("https://gh-proxy.com/{}", asset.download_url);
                log::warn!(
                    "{} url='{}'",
                    fallback_log_tag,
                    crate::log_support::sanitize_url(&fallback_url)
                );
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    DownloadProgressPayload {
                        task_id: app_id.to_string(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        speed_bytes_per_sec: 0,
                        state: "downloading".to_string(),
                        message: Some("直连通道不稳定，正在切换公共加速镜像自动重试...".to_string()),
                    },
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

/// 仅下载：复用安装通道的镜像改写 + 流式下载 + SHA-256 校验 + 进度事件，
/// 但不调用任何安装器。文件落盘至用户配置的下载目录，前端展示进度并提供“打开所在文件夹”。
#[tauri::command]
pub async fn download_asset(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
) -> Result<DownloadAssetResult, String> {
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    let custom_download_dir = resolve_download_dir(&state);

    let detail = super::catalog::get_app_details(state.clone(), app_id.clone(), None).await?;

    let selected_asset = if let Some(ref target_name) = asset_name {
        detail.releases.iter().find(|r| &r.name == target_name)
    } else {
        None
    };
    let asset = selected_asset
        .or_else(|| super::select_best_asset(&detail.releases))
        .ok_or_else(|| "该 Release 未提供可下载的产物资产".to_string())?;

    let (dest_path, actual_sha256) = download_asset_with_fallback(
        &app_handle,
        &state,
        &app_id,
        asset,
        custom_download_dir.as_deref(),
        "download-only init",
        "download-only direct failed, retrying via fallback mirror",
    )
    .await?;

    let verified = asset
        .sha256
        .as_deref()
        .map(|s| !s.trim().is_empty() && s.trim().to_lowercase() == actual_sha256.to_lowercase())
        .unwrap_or(false);
    let file_name = dest_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| asset.name.clone());
    let dir = dest_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(DownloadAssetResult {
        file_path: dest_path.to_string_lossy().to_string(),
        file_name,
        dir,
        sha256: actual_sha256,
        verified,
    })
}

fn open_path_with_system(path: &std::path::Path, select_file: bool) -> Result<bool, String> {
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.to_string_lossy()));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if select_file && path.is_file() {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("无法打开文件所在目录: {}", e))?;
        } else {
            let dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            std::process::Command::new("explorer")
                .arg(dir)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("无法打开目录: {}", e))?;
        }
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        if select_file {
            std::process::Command::new("open")
                .args(["-R", &path.to_string_lossy().to_string()])
                .spawn()
                .map_err(|e| format!("无法在访达中定位文件: {}", e))?;
        } else {
            let dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            std::process::Command::new("open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("无法打开目录: {}", e))?;
        }
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {}", e))?;
        return Ok(true);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, select_file);
        Err("当前操作系统不支持打开本地目录".to_string())
    }
}

/// 在系统文件管理器中选中已下载的文件（Windows 资源管理器 /select，macOS 访达 -R，Linux 打开父目录）。
#[tauri::command]
pub fn show_file_in_folder(path: String) -> Result<bool, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径为空".to_string());
    }
    open_path_with_system(std::path::Path::new(trimmed), true)
}

/// 直接打开目录（若传入文件路径则打开其父目录）。
#[tauri::command]
pub fn open_folder(path: String) -> Result<bool, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径为空".to_string());
    }
    open_path_with_system(std::path::Path::new(trimmed), false)
}
