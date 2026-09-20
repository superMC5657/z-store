#[cfg(target_os = "linux")]
use super::InstallOutcome;
#[cfg(target_os = "linux")]
use std::path::Path;

/// Linux AppImage 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_appimage(installer_path: &Path) -> Result<InstallOutcome, String> {
    let _ = tokio::process::Command::new("chmod")
        .arg("+x")
        .arg(installer_path)
        .status()
        .await;
    let status = tokio::process::Command::new(installer_path)
        .status()
        .await
        .map_err(|e| format!("启动 AppImage 失败: {}", e))?;
    if status.success() {
        Ok(InstallOutcome::Installed("已赋予可执行权限并启动 AppImage".to_string()))
    } else {
        Err("AppImage 执行未正常退出".to_string())
    }
}

/// Linux deb 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_deb(installer_path: &Path) -> Result<InstallOutcome, String> {
    let status = tokio::process::Command::new("pkexec")
        .arg("dpkg")
        .arg("-i")
        .arg(installer_path)
        .status()
        .await
        .map_err(|e| format!("调起 pkexec dpkg 失败: {}", e))?;
    let _ = std::fs::remove_file(installer_path);
    if status.success() {
        Ok(InstallOutcome::Installed("deb 包安装已完成".to_string()))
    } else {
        Err("deb 包提权安装未完成或被取消".to_string())
    }
}

/// Linux rpm 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_rpm(installer_path: &Path) -> Result<InstallOutcome, String> {
    let status = tokio::process::Command::new("pkexec")
        .arg("rpm")
        .arg("-i")
        .arg(installer_path)
        .status()
        .await
        .map_err(|e| format!("调起 pkexec rpm 失败: {}", e))?;
    let _ = std::fs::remove_file(installer_path);
    if status.success() {
        Ok(InstallOutcome::Installed("rpm 包安装已完成".to_string()))
    } else {
        Err("rpm 包提权安装未完成或被取消".to_string())
    }
}
