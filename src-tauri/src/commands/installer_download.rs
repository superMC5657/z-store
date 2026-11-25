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

/// 直连失败时的 GitHub 公共镜像回退编排核心（纯异步可测）：
/// - 仅当原始链接为 GitHub 域且首跳为直连（无 `bypass_proxy_host`）时触发 `gh-proxy` 兜底重试；
/// - 非 GitHub 链接或首跳已走自定义镜像时直接透传原错误，避免循环重写。
async fn download_asset_with_fallback_using<F, Fut>(
    resolved: &crate::mirror::ResolvedDownloadUrl,
    app_id: &str,
    asset: &ReleaseAsset,
    mut on_fallback: impl FnMut(&str),
    mut fetch: F,
) -> Result<(std::path::PathBuf, String), String>
where
    F: FnMut(String, Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<(std::path::PathBuf, String), String>>,
{
    let download_res = fetch(resolved.url.clone(), resolved.bypass_hosts()).await;

    match download_res {
        Ok(ok) => Ok(ok),
        Err(e) => {
            let is_github = crate::mirror::is_github_domain(&asset.download_url);
            let is_direct = resolved.bypass_proxy_host.is_none();
            if is_github && is_direct {
                let fallback = crate::mirror::wrap_gh_proxy_resolved(&asset.download_url);
                let fallback_url = fallback.url.clone();
                let mut ev = crate::z_log::WideEvent::new("download", "mirror fallback");
                ev.field("id", app_id)
                    .field("file", crate::log_support::file_base(&asset.name))
                    .field("reason", crate::log_support::short_reason(&e))
                    .dev_url("url", &fallback_url);
                ev.warn();
                on_fallback("直连通道不稳定，正在切换公共加速镜像自动重试...");
                fetch(fallback_url, fallback.bypass_hosts())
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

/// 安装与仅下载共用的下载通道：经用户配置镜像加速（仅安装包通道），
/// 含流式下载 + SHA-256 校验 + 进度事件；直连失败且为 GitHub 链接时公共兜底重试。
pub(crate) async fn download_asset_with_fallback(
    app_handle: &AppHandle,
    state: &AppState,
    app_id: &str,
    asset: &ReleaseAsset,
    custom_download_dir: Option<&std::path::Path>,
) -> Result<(std::path::PathBuf, String), String> {
    let resolved = {
        let mirror = state.mirror.lock().map_err(|e| e.to_string())?;
        mirror.rewrite_installer_asset_url_resolved(&asset.download_url)
    };

    download_asset_with_fallback_using(
        &resolved,
        app_id,
        asset,
        |msg| {
            DownloadProgressPayload::emit_event(
                app_handle,
                app_id,
                0,
                0,
                0,
                "downloading",
                Some(msg.to_string()),
            );
        },
        |url, bypass_hosts| async move {
            crate::installer::download_with_progress(
                app_handle,
                app_id,
                &url,
                &bypass_hosts,
                &asset.name,
                asset.sha256.as_deref(),
                custom_download_dir,
            )
            .await
        },
    )
    .await
}

pub(crate) struct PreparedDownload {
    pub asset: ReleaseAsset,
    pub dest_path: std::path::PathBuf,
    pub actual_sha256: String,
}

/// 获取详情并择取待下载资产；与实际下载分离，便于安装流程先执行校验门禁。
pub(crate) async fn select_download_asset(
    state: &State<'_, AppState>,
    app_id: &str,
    asset_name: Option<&str>,
    missing_asset_err: &str,
) -> Result<(crate::models::AppDetail, ReleaseAsset), String> {
    let detail =
        super::catalog_detail::get_app_details(state.clone(), app_id.to_string(), None).await?;

    let selected_asset = if let Some(target_name) = asset_name {
        detail
            .releases
            .iter()
            .find(|r| r.name == target_name)
            .cloned()
    } else {
        None
    };

    let asset = selected_asset
        .or_else(|| super::select_best_asset(&detail.releases).cloned())
        .ok_or_else(|| missing_asset_err.to_string())?;

    Ok((detail, asset))
}

pub(crate) async fn prepare_and_download_asset(
    app_handle: &AppHandle,
    state: &State<'_, AppState>,
    app_id: &str,
    asset_name: Option<&str>,
    missing_asset_err: &str,
) -> Result<PreparedDownload, String> {
    let custom_download_dir = resolve_download_dir(state);
    let (_, asset) = select_download_asset(state, app_id, asset_name, missing_asset_err).await?;

    let (dest_path, actual_sha256) = download_asset_with_fallback(
        app_handle,
        state,
        app_id,
        &asset,
        custom_download_dir.as_deref(),
    )
    .await?;

    Ok(PreparedDownload {
        asset,
        dest_path,
        actual_sha256,
    })
}

/// 仅下载：复用安装通道（经用户配置镜像加速）+ 流式下载 + SHA-256 校验 + 进度事件，
/// 但不调用任何安装器。文件落盘至用户配置的下载目录，前端展示进度并提供“打开所在文件夹”。
#[tauri::command(rename_all = "camelCase")]
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
    Ok(super::system::open_desktop_path(
        std::path::Path::new(trimmed),
        true,
    )?)
}

/// 直接打开目录（若传入文件路径则打开其父目录）。
#[tauri::command]
pub fn open_folder(path: String) -> crate::AppResult<bool> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(crate::AppError::new("目录路径为空"));
    }
    Ok(super::system::open_desktop_path(
        std::path::Path::new(trimmed),
        false,
    )?)
}

#[cfg(test)]
mod download_fallback_tests {
    use super::download_asset_with_fallback_using;
    use crate::mirror::MirrorManager;
    use crate::models::ReleaseAsset;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn mk_asset(url: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: "app-win64.zip".to_string(),
            download_url: url.to_string(),
            size_bytes: 1024,
            sha256: None,
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            kind: "portable_zip".to_string(),
        }
    }

    type AttemptLog = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    #[tokio::test]
    async fn github_direct_failure_falls_back_to_public_mirror_with_bypass_host() {
        let mirror = MirrorManager::new();
        let asset =
            mk_asset("https://github.com/owner/repo/releases/download/v1.0.0/app-win64.zip");
        let resolved = mirror.rewrite_installer_asset_url_resolved(&asset.download_url);
        assert!(resolved.bypass_proxy_host.is_none());

        let attempts: AttemptLog = Arc::new(Mutex::new(Vec::new()));
        let attempts_cb = Arc::clone(&attempts);
        let mut fallback_notices = Vec::new();

        let (path, sha) = download_asset_with_fallback_using(
            &resolved,
            "owner/repo",
            &asset,
            |msg| fallback_notices.push(msg.to_string()),
            |url, bypass| {
                let attempts_cb = Arc::clone(&attempts_cb);
                async move {
                    let idx = {
                        let mut g = attempts_cb.lock().unwrap();
                        g.push((url.clone(), bypass.clone()));
                        g.len()
                    };
                    if idx == 1 {
                        Err("connection reset".to_string())
                    } else {
                        Ok((PathBuf::from("ok.zip"), "abc123".to_string()))
                    }
                }
            },
        )
        .await
        .expect("mirror fallback should recover after direct failure");

        assert_eq!(path, PathBuf::from("ok.zip"));
        assert_eq!(sha, "abc123");
        assert_eq!(fallback_notices.len(), 1);
        let calls = attempts.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, asset.download_url);
        assert!(
            calls[0].1.is_empty(),
            "direct attempt must not bypass proxy"
        );
        assert!(
            calls[1].0.contains("github.com/owner/repo") && calls[1].0 != asset.download_url,
            "fallback URL must wrap original GitHub URL: {}",
            calls[1].0
        );
        assert!(
            !calls[1].1.is_empty(),
            "fallback mirror must include mirror host in bypass_proxy_hosts"
        );
    }

    #[tokio::test]
    async fn github_direct_and_fallback_both_fail_reports_combined_error() {
        let mirror = MirrorManager::new();
        let asset =
            mk_asset("https://github.com/owner/repo/releases/download/v1.0.0/app-win64.zip");
        let resolved = mirror.rewrite_installer_asset_url_resolved(&asset.download_url);

        let err = download_asset_with_fallback_using(
            &resolved,
            "owner/repo",
            &asset,
            |_| {},
            |url, _| async move {
                if url == "https://github.com/owner/repo/releases/download/v1.0.0/app-win64.zip" {
                    Err("direct timeout".to_string())
                } else {
                    Err("mirror 502".to_string())
                }
            },
        )
        .await
        .expect_err("both direct and fallback failures must return Err");

        assert!(err.contains("direct timeout"), "{err}");
        assert!(err.contains("mirror 502"), "{err}");
    }

    #[tokio::test]
    async fn non_github_or_already_mirrored_download_does_not_fallback() {
        // 1. 非 GitHub 源失败绝不回退到 GitHub 公共镜像
        let direct = MirrorManager::new();
        let cb_asset = mk_asset("https://codeberg.org/owner/repo/releases/download/v1/app.zip");
        let cb_resolved = direct.rewrite_installer_asset_url_resolved(&cb_asset.download_url);
        let cb_calls = Arc::new(Mutex::new(0usize));
        let cb_calls_inner = Arc::clone(&cb_calls);
        let err = download_asset_with_fallback_using(
            &cb_resolved,
            "codeberg:owner/repo",
            &cb_asset,
            |_| panic!("non-GitHub asset must not emit fallback notice"),
            |_, _| {
                let c = Arc::clone(&cb_calls_inner);
                async move {
                    *c.lock().unwrap() += 1;
                    Err("codeberg 503".to_string())
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "codeberg 503");
        assert_eq!(*cb_calls.lock().unwrap(), 1);

        // 2. 已启用加速镜像的首跳失败不再重复回退
        let mut ghproxy = MirrorManager::new();
        assert!(ghproxy.set_active_mirror("ghproxy"));
        let gh_asset = mk_asset("https://github.com/owner/repo/releases/download/v1/app.zip");
        let gh_resolved = ghproxy.rewrite_installer_asset_url_resolved(&gh_asset.download_url);
        assert!(gh_resolved.bypass_proxy_host.is_some());
        let gh_calls = Arc::new(Mutex::new(0usize));
        let gh_calls_inner = Arc::clone(&gh_calls);
        let err2 = download_asset_with_fallback_using(
            &gh_resolved,
            "owner/repo",
            &gh_asset,
            |_| panic!("already-mirrored request must not double-fallback"),
            |_, _| {
                let c = Arc::clone(&gh_calls_inner);
                async move {
                    *c.lock().unwrap() += 1;
                    Err("mirror failed".to_string())
                }
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err2, "mirror failed");
        assert_eq!(*gh_calls.lock().unwrap(), 1);
    }
}
