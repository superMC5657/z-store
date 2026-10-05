use super::installer_download::prepare_and_download_asset;
use super::{resolve_uninstaller_command, InstallerEngine};
use crate::models::InstalledApp;
use crate::AppState;
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
    let app_id = super::require_app_id(&app_id)?;
    // 读取用户配置（绿色便携根路径）
    let custom_portable_dir = {
        if let Ok(db) = state.db() {
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

    // 1-3. 获取应用详情、匹配择取资产、镜像改写 + 流式下载 + SHA-256 完整性强校验（与仅下载共用通道）
    let prep = prepare_and_download_asset(
        &app_handle,
        &state,
        &app_id,
        asset_name.as_deref(),
        "该 Release 未提供匹配当前操作系统的安装包资产",
        "download init",
        "download direct failed, retrying via fallback mirror",
    )
    .await?;

    // 4. 调用原生安装器或解压便携版（优先使用用户在前端主动选择的目录）
    let (kind, _, _) = InstallerEngine::classify_asset(&prep.asset.name);
    let effective_portable_dir = custom_install_dir.or(custom_portable_dir);
    // Finding 3.3-4：平台跳过是结构化非成功信号，映射为 Err 中断、
    // 绝不落库为"已安装"（经 InstallOutcome::into_result 统一）。
    let _install_note = InstallerEngine::execute_installation(
        &prep.dest_path,
        &kind,
        &prep.detail.id,
        effective_portable_dir.as_deref(),
    )
    .await?
    .into_result()?;

    // 智能解析真实安装路径，避免存入临时安装包路径
    let mut real_install_path = match kind {
        crate::installer::AssetKind::PortableZip
        | crate::installer::AssetKind::PortableTarball => {
            let app_dir = crate::installer::dirs_or_fallback_with_base(
                &prep.detail.id,
                effective_portable_dir.as_deref(),
            );
            crate::scanner::AppScanner::resolve_executable_path(
                Some(&app_dir.to_string_lossy()),
                None,
                &prep.detail.repo,
            )
            .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
        }
        _ => crate::scanner::AppScanner::resolve_installed_app_path(
            &prep.detail.name,
            &prep.detail.id,
            Some(&prep.detail.repo),
        )
        .unwrap_or_default(),
    };

    // 针对外部向导安装，若未立即捕获路径，进行短暂重试嗅探 (最多 5 次，每次 500ms)
    if real_install_path.is_empty()
        && kind != crate::installer::AssetKind::PortableZip
        && kind != crate::installer::AssetKind::PortableTarball
    {
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Some(p) = crate::scanner::AppScanner::resolve_installed_app_path(
                &prep.detail.name,
                &prep.detail.id,
                Some(&prep.detail.repo),
            ) {
                real_install_path = p;
                break;
            }
        }
    }

    // Linux deb/rpm：dpkg -L / desktop Exec / which 回填（pkexec dpkg -i 后
    // resolve 仍可能因包名与 repo 名不一致而为空，如 Motrix 包名 `motrix` vs repo `Motrix`）。
    // Windows 编译时整块消除，行为不变。
    #[cfg(target_os = "linux")]
    {
        let is_sys_pkg = matches!(
            kind,
            crate::installer::AssetKind::Deb | crate::installer::AssetKind::Rpm
        );
        if real_install_path.is_empty() && is_sys_pkg {
            // 候选包名：catalog linux 标识优先，其次 repo/id/名称派生小写
            let mut pkg_names: Vec<String> = Vec::new();
            if let Some(cat) = state.catalog.get_catalog_item(&prep.detail.id) {
                for id in cat.get_native_identifiers() {
                    let t = id.trim().to_lowercase();
                    if !t.is_empty() && !pkg_names.contains(&t) {
                        pkg_names.push(t);
                    }
                }
            }
            for cand in [
                prep.detail.repo.clone(),
                prep.detail
                    .id
                    .rsplit('/')
                    .next()
                    .unwrap_or(&prep.detail.id)
                    .to_string(),
                prep.detail.name.clone(),
            ] {
                let t = cand.trim().to_lowercase();
                if t.len() >= 2 && !t.contains(' ') && !pkg_names.contains(&t) {
                    pkg_names.push(t);
                }
            }
            // 候选二进制名：linux 标识 + 包名 + repo 小写
            let mut bin_names: Vec<String> = pkg_names.clone();
            if let Some(cat) = state.catalog.get_catalog_item(&prep.detail.id) {
                for id in cat.get_native_identifiers() {
                    if !bin_names.contains(&id) {
                        bin_names.push(id);
                    }
                }
            }
            if let Some(found) =
                crate::installer::executor::linux::resolve_deb_installed_path(
                    &pkg_names,
                    &bin_names,
                )
            {
                real_install_path = found;
            } else if let Some(found) =
                crate::installer::executor::linux::resolve_desktop_installed_path(&bin_names)
            {
                real_install_path = found;
            } else {
                // 最后兜底：PATH/which 直查
                for name in &bin_names {
                    if let Some(found) = crate::scanner::AppScanner::which_binary(name) {
                        real_install_path = found;
                        break;
                    }
                }
            }
        }
    }

    let resolved_uninst =
        resolve_uninstaller_command(&prep.detail.name, &prep.detail.id, &real_install_path, None);

    // 5. 写入本地 SQLite 持久化
    let installed_app = InstalledApp {
        app_id: prep.detail.id.clone(),
        app_name: prep.detail.name.clone(),
        version: prep.detail.latest_version.clone(),
        installed_at: crate::now_secs(),
        install_method: prep.asset.kind.clone(),
        install_path: real_install_path,
        asset_name: prep.asset.name.clone(),
        asset_sha256: prep.actual_sha256,
        uninstall_command: resolved_uninst,
        icon: Some(prep.detail.icon.clone()),
        icon_bg: Some(prep.detail.icon_bg.clone()),
    };

    {
        let db = state.db()?;
        db.save_installed_app(&installed_app)
            .map_err(|e| e.to_string())?;
    }

    // 精准将新安装的应用增量写入常驻缓存，避免全盘重新扫描
    crate::commands::scanner::add_to_detected_cache(&prep.detail.id);

    Ok(installed_app)
}
