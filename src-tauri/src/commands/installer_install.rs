use crate::models::InstalledApp;
use crate::AppState;
use super::catalog::get_app_details;
use super::installer_download::{download_asset_with_fallback, resolve_download_dir};
use super::{resolve_uninstaller_command, select_best_asset, InstallerEngine};
use tauri::{AppHandle, State};

/// 安装流程核心实现（从 `installer.rs` 抽离；命令包装层保留在原处）。
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
) -> Result<InstalledApp, String> {
    // ADR-0010：深链安装可能传入 URL/前缀形态，入站归一化后全程使用 canonical id；未知标识直接拒绝
    let Some(app_id) = crate::forge::canonical_app_id(&app_id) else {
        return Err(format!("无法识别的应用标识: {}", app_id));
    };
    // 读取用户配置（自定义下载路径、绿色便携根路径）
    let custom_download_dir = resolve_download_dir(&state);
    let custom_portable_dir = {
        if let Ok(db) = state.db.lock() {
            db.get_setting("portable_dir").ok().flatten().and_then(|s| {
                let t = s.trim().to_string();
                if !t.is_empty() {
                    Some(t)
                } else {
                    None
                }
            })
        } else {
            None
        }
    };

    // 1. 获取应用详情与择取匹配资产（支持前端主动指定 asset_name，若未指定则按当前架构自适应择优）
    let detail = get_app_details(state.clone(), app_id.clone(), None).await?;

    let selected_asset = if let Some(ref target_name) = asset_name {
        detail.releases.iter().find(|r| &r.name == target_name)
    } else {
        None
    };

    let asset = selected_asset
        .or_else(|| select_best_asset(&detail.releases))
        .ok_or_else(|| "该 Release 未提供匹配当前操作系统的安装包资产".to_string())?;

    // 2-3. 镜像改写 + 流式下载 + SHA-256 完整性防篡改强校验（与仅下载共用通道）
    let (dest_path, actual_sha256) = download_asset_with_fallback(
        &app_handle,
        &state,
        &app_id,
        asset,
        custom_download_dir.as_deref(),
        "download init",
        "download direct failed, retrying via fallback mirror",
    )
    .await?;

    // 4. 调用原生安装器或解压便携版（优先使用用户在前端主动选择的目录）
    let (kind, _, _) = InstallerEngine::classify_asset(&asset.name);
    let effective_portable_dir = custom_install_dir.or(custom_portable_dir);
    // Finding 3.3-4：平台跳过是结构化非成功信号，映射为 Err 中断、
    // 绝不落库为"已安装"（经 InstallOutcome::into_result 统一）。
    let _install_note = InstallerEngine::execute_installation(
        &dest_path,
        &kind,
        &detail.id,
        effective_portable_dir.as_deref(),
    )
    .await?
    .into_result()?;

    // 智能解析真实安装路径，避免存入临时安装包路径
    let mut real_install_path = match kind {
        crate::installer::AssetKind::PortableZip => {
            let app_dir = crate::installer::dirs_or_fallback_with_base(
                &detail.id,
                effective_portable_dir.as_deref(),
            );
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_installed_app_path(
            &detail.name,
            &detail.id,
            Some(&detail.repo),
        )
        .unwrap_or_default(),
    };

    // 针对外部向导安装，若未立即捕获路径，进行短暂重试嗅探 (最多 5 次，每次 500ms)
    if real_install_path.is_empty() && kind != crate::installer::AssetKind::PortableZip {
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Some(p) = crate::scanner::AppScanner::resolve_installed_app_path(
                &detail.name,
                &detail.id,
                Some(&detail.repo),
            ) {
                real_install_path = p;
                break;
            }
        }
    }

    let resolved_uninst = resolve_uninstaller_command(
        &detail.name,
        &detail.id,
        &real_install_path,
        None,
    );

    // 5. 写入本地 SQLite 持久化
    let installed_app = InstalledApp {
        app_id: detail.id.clone(),
        app_name: detail.name.clone(),
        version: detail.latest_version.clone(),
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
        install_method: asset.kind.clone(),
        install_path: real_install_path,
        asset_name: asset.name.clone(),
        asset_sha256: actual_sha256,
        uninstall_command: resolved_uninst,
        icon: Some(detail.icon.clone()),
        icon_bg: Some(detail.icon_bg.clone()),
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    // 精准将新安装的应用增量写入常驻缓存，避免全盘重新扫描
    crate::commands::scanner::add_to_detected_cache(&detail.id);

    Ok(installed_app)
}
