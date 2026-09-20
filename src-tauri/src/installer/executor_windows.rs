#[cfg(target_os = "windows")]
use super::{silent_args_for_setup_kind, sniff_setup_kind_from_file, InstallOutcome};
#[cfg(target_os = "windows")]
use std::path::Path;

/// Windows MSI 安装体（原 executor.rs 内联 cfg(windows) 分支纯移动）。
#[cfg(target_os = "windows")]
pub async fn install_msi(
    installer_path: &Path,
    app_id: &str,
) -> Result<InstallOutcome, String> {
    use std::time::Duration;
    // FR-3.5 静默优先：首先尝试 `msiexec /i <pkg> /qn /norestart` 全静默安装
    let silent_status = tokio::process::Command::new("msiexec.exe")
        .arg("/i")
        .arg(installer_path)
        .arg("/qn")
        .arg("/norestart")
        .status()
        .await
        .map_err(|e| format!("调起 MSI 静默安装器失败: {}", e))?;

    if silent_status.success() {
        tokio::time::sleep(Duration::from_millis(800)).await;
        let _ = std::fs::remove_file(installer_path);
        return Ok(InstallOutcome::Installed("MSI 静默安装已完成".to_string()));
    }

    let code = silent_status.code().unwrap_or(-1);
    if code == 1602 {
        let _ = std::fs::remove_file(installer_path);
        return Err("用户取消了 MSI 安装向导".to_string());
    }

    log::info!(
        "install silent failed sid={} code={}, fallback to interactive wizard id={}",
        crate::z_log::new_session_id(),
        code,
        app_id
    );

    // 静默被拒绝或非零退出：降级拉起原生 GUI 向导，并等待用户在向导中完成或取消
    let mut fallback = tokio::process::Command::new("msiexec.exe")
        .arg("/i")
        .arg(installer_path)
        .spawn()
        .map_err(|e| {
            format!("静默安装被拒绝且拉起 MSI 向导失败: {}", e)
        })?;

    let fallback_status = fallback
        .wait()
        .await
        .map_err(|e| format!("MSI 向导进程异常: {}", e))?;

    let _ = std::fs::remove_file(installer_path);

    if fallback_status.success() {
        tokio::time::sleep(Duration::from_millis(800)).await;
        Ok(InstallOutcome::Installed("MSI 安装已完成".to_string()))
    } else {
        let fb_code = fallback_status.code().unwrap_or(-1);
        if fb_code == 1602 {
            Err("用户取消了 MSI 安装向导".to_string())
        } else {
            Err(format!("MSI 安装未能成功完成 (退出代码: {})", fb_code))
        }
    }
}

/// Windows SetupExe 安装体（原 executor.rs 内联 cfg(windows) 分支纯移动）。
#[cfg(target_os = "windows")]
pub async fn install_setup_exe(
    installer_path: &Path,
    app_id: &str,
) -> Result<InstallOutcome, String> {
    use std::time::Duration;
    // Finding 3.3-3：嗅探安装器类型并传递静默参数（NSIS ⇒ /S，
    // Inno Setup ⇒ /VERYSILENT /NORESTART；未知类型 ⇒ 交互式回退，绝不猜测）。
    let setup_kind = sniff_setup_kind_from_file(installer_path);
    let silent_args = silent_args_for_setup_kind(&setup_kind);
    if silent_args.is_empty() {
        log::info!(
            "install setup sniff sid={} kind=unknown, interactive fallback id={}",
            crate::z_log::new_session_id(),
            app_id
        );
    } else {
        log::info!(
            "install setup sniff sid={} kind={:?} args={:?} id={}",
            crate::z_log::new_session_id(),
            setup_kind,
            silent_args,
            app_id
        );
    }
    let mut child = tokio::process::Command::new(installer_path)
        .args(&silent_args)
        .spawn()
        .map_err(|e| format!("调起安装程序失败: {}", e))?;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("安装程序运行异常: {}", e))?;

    tokio::time::sleep(Duration::from_millis(800)).await;
    let _ = std::fs::remove_file(installer_path);

    if status.success() {
        Ok(InstallOutcome::Installed("安装程序已完成".to_string()))
    } else {
        let code = status.code().unwrap_or(-1);
        if code == 1602 || code == 1 || code == 2 {
            Err(format!("用户取消了安装向导或安装已中止 (退出代码: {})", code))
        } else {
            Err(format!("安装程序未能成功完成 (退出代码: {})", code))
        }
    }
}

/// Windows 通用回退安装体（原 `_` 分支内联 cfg(windows) 纯移动）。
#[cfg(target_os = "windows")]
pub async fn install_fallback_default(
    installer_path: &Path,
) -> Result<InstallOutcome, String> {
    let status = tokio::process::Command::new("cmd.exe")
        .arg("/c")
        .arg("start")
        .arg("/wait")
        .arg(installer_path)
        .status()
        .await
        .map_err(|e| format!("调起系统默认程序失败: {}", e))?;
    let _ = std::fs::remove_file(installer_path);
    if status.success() {
        Ok(InstallOutcome::Installed("系统默认程序已处理完成".to_string()))
    } else {
        Err("处理未正常完成".to_string())
    }
}
