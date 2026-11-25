use super::resolve_uninstaller_command;
use crate::models::InstalledApp;
use crate::{AppResult, AppState};
use tauri::{AppHandle, State};

/// 无官方 SHA-256 校验清单时的安装门禁：默认拒绝，仅在用户显式确认（`allow_unverified == Some(true)`）后放行。
pub(crate) fn check_unverified_asset_gate(
    asset: &crate::models::ReleaseAsset,
    allow_unverified: Option<bool>,
) -> Result<(), String> {
    let has_checksum = asset
        .sha256
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_checksum && allow_unverified != Some(true) {
        return Err(
            "unverified-asset-required: 该资产未提供官方 SHA-256 校验清单，无法验证文件完整性，已默认拒绝安装。可在确认弹窗了解风险后显式继续，或改用带 checksums 清单的版本"
                .to_string(),
        );
    }
    Ok(())
}

/// 安装应用核心命令。
#[tauri::command(rename_all = "camelCase")]
pub async fn install_app(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    app_id: String,
    asset_name: Option<String>,
    custom_install_dir: Option<String>,
    allow_unverified: Option<bool>,
) -> AppResult<InstalledApp> {
    // 归一化入站 app_id（支持 URL/前缀形态），未知标识直接拒绝。
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

    // 先择取资产并执行校验门禁，再下载落盘。
    let (detail, asset) = super::installer_download::select_download_asset(
        &state,
        &app_id,
        asset_name.as_deref(),
        "该 Release 未提供匹配当前操作系统的安装包资产",
    )
    .await?;

    // 默认拒绝无 SHA-256 校验清单的资产，仅在用户显式确认（allow_unverified）后放行。
    check_unverified_asset_gate(&asset, allow_unverified)?;

    // 3. 经用户配置镜像加速下载 + SHA-256 完整性强校验（与仅下载共用通道）
    let custom_download_dir = super::installer_download::resolve_download_dir(&state);
    let (dest_path, actual_sha256) = super::installer_download::download_asset_with_fallback(
        &app_handle,
        &state,
        &app_id,
        &asset,
        custom_download_dir.as_deref(),
    )
    .await?;

    // 4. 调用原生安装器或解压便携版（优先使用用户在前端主动选择的目录）
    let (kind, _, _) = crate::installer::classify_asset(&asset.name);
    let effective_portable_dir = custom_install_dir.or(custom_portable_dir);
    // 平台跳过等非成功结果映射为 Err 中断，避免写入已安装记录。
    let _install_note = crate::installer::executor::execute_installation_with_name(
        &dest_path,
        &kind,
        &detail.core.id,
        Some(&detail.core.name),
        effective_portable_dir.as_deref(),
    )
    .await?
    .into_result()?;

    // 智能解析真实安装路径，避免存入临时安装包路径（注册表 / 跨盘符探测在阻塞线程池执行）
    let (core_id, core_name, core_repo) = (
        detail.core.id.clone(),
        detail.core.name.clone(),
        detail.core.repo.clone(),
    );
    let mut real_install_path = {
        let (id, name, repo) = (core_id.clone(), core_name.clone(), core_repo.clone());
        let kind = kind.clone();
        let portable_dir = effective_portable_dir.clone();
        crate::installer::run_blocking(move || match kind {
            crate::installer::AssetKind::PortableZip
            | crate::installer::AssetKind::PortableTarball => {
                let app_dir =
                    crate::installer::dirs_or_fallback_with_base(&id, portable_dir.as_deref());
                crate::scanner::AppScanner::resolve_executable_path(
                    Some(&app_dir.to_string_lossy()),
                    None,
                    &repo,
                )
                .unwrap_or_else(|| app_dir.to_string_lossy().to_string())
            }
            _ => crate::scanner::AppScanner::resolve_installed_app_path(&name, &id, Some(&repo))
                .unwrap_or_default(),
        })
        .await?
    };

    // 针对外部向导安装，若未立即捕获路径，进行短暂重试嗅探 (最多 5 次，每次 500ms)
    if real_install_path.is_empty()
        && kind != crate::installer::AssetKind::PortableZip
        && kind != crate::installer::AssetKind::PortableTarball
    {
        for _ in 0..5 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let (id, name, repo) = (core_id.clone(), core_name.clone(), core_repo.clone());
            let found = crate::installer::run_blocking(move || {
                crate::scanner::AppScanner::resolve_installed_app_path(&name, &id, Some(&repo))
            })
            .await?;
            if let Some(p) = found {
                real_install_path = p;
                break;
            }
        }
    }

    // Linux 系统包回填：按包管理器文件列表（dpkg/rpm）、desktop Exec 与 PATH 顺序定位主程序。
    #[cfg(target_os = "linux")]
    {
        let is_sys_pkg = matches!(
            kind,
            crate::installer::AssetKind::Deb | crate::installer::AssetKind::Rpm
        );
        if real_install_path.is_empty() && is_sys_pkg {
            let catalog_ids = state
                .catalog
                .get_catalog_item(&detail.core.id)
                .map(|cat| cat.get_native_identifiers())
                .unwrap_or_default();
            let (pkg_names, bin_names) = crate::scanner::AppScanner::linux_candidate_names(
                &catalog_ids,
                &[
                    detail.core.repo.clone(),
                    detail.core.id.clone(),
                    detail.core.name.clone(),
                ],
            );
            // 系统包回填：先包管理器列表（deb/rpm 按 kind 分流），再 desktop Exec，最后 PATH/which。
            let sys_found = match kind {
                crate::installer::AssetKind::Rpm => {
                    crate::installer::executor::linux::resolve_rpm_installed_path(
                        &pkg_names, &bin_names,
                    )
                }
                _ => crate::installer::executor::linux::resolve_deb_installed_path(
                    &pkg_names, &bin_names,
                ),
            };
            if let Some(found) = sys_found.or_else(|| {
                crate::installer::paths::linux_binary_candidates(&bin_names)
                    .into_iter()
                    .next()
            }) {
                real_install_path = found;
            }
        }
    }

    let resolved_uninst = {
        let (id, name, path) = (core_id, core_name, real_install_path.clone());
        crate::installer::run_blocking(move || resolve_uninstaller_command(&name, &id, &path, None))
            .await?
    };

    let installed_app = InstalledApp {
        app_id: detail.core.id.clone(),
        app_name: detail.core.name.clone(),
        version: detail.core.latest_version.clone(),
        installed_at: crate::now_secs(),
        install_method: asset.kind.clone(),
        install_path: real_install_path,
        asset_name: asset.name.clone(),
        asset_sha256: actual_sha256,
        uninstall_command: resolved_uninst,
        icon: Some(detail.core.icon.clone()),
        icon_bg: Some(detail.core.icon_bg.clone()),
    };

    {
        let db = state.db()?;
        crate::installer::managed::record_installed(&db, &installed_app)
            .map_err(|e| e.to_string())?;
    }

    Ok(installed_app)
}

#[cfg(test)]
mod unverified_gate_tests {
    use super::check_unverified_asset_gate;
    use crate::models::ReleaseAsset;

    fn mk_asset(sha256: Option<&str>) -> ReleaseAsset {
        ReleaseAsset {
            name: "app-setup.exe".to_string(),
            download_url: "https://github.com/owner/repo/releases/download/v1.0.0/app-setup.exe"
                .to_string(),
            size_bytes: 1024,
            sha256: sha256.map(str::to_string),
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            kind: "setup_exe".to_string(),
        }
    }

    #[test]
    fn unverified_asset_is_blocked_unless_explicitly_allowed() {
        let no_sha = mk_asset(None);
        let err_none = check_unverified_asset_gate(&no_sha, None)
            .expect_err("missing sha256 with allow_unverified=None must be rejected");
        assert!(err_none.starts_with("unverified-asset-required:"));

        let err_false = check_unverified_asset_gate(&no_sha, Some(false))
            .expect_err("missing sha256 with allow_unverified=Some(false) must be rejected");
        assert!(err_false.starts_with("unverified-asset-required:"));

        let blank_sha = mk_asset(Some("   "));
        assert!(check_unverified_asset_gate(&blank_sha, None).is_err());

        // 用户显式确认 allow_unverified=Some(true) 时放行
        assert!(check_unverified_asset_gate(&no_sha, Some(true)).is_ok());
        assert!(check_unverified_asset_gate(&blank_sha, Some(true)).is_ok());
    }

    #[test]
    fn verified_asset_passes_regardless_of_allow_unverified() {
        let with_sha = mk_asset(Some(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ));
        assert!(check_unverified_asset_gate(&with_sha, None).is_ok());
        assert!(check_unverified_asset_gate(&with_sha, Some(false)).is_ok());
        assert!(check_unverified_asset_gate(&with_sha, Some(true)).is_ok());
    }
}
