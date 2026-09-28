#[cfg(target_os = "linux")]
use super::InstallOutcome;
use std::path::Path;

/// Linux 提权安装 argv 纯函数（供单测直调锁定真实实现，防旧桩漂移）。
pub fn deb_install_argv(path: &Path) -> Vec<String> {
    vec![
        "pkexec".to_string(),
        "dpkg".to_string(),
        "-i".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

/// Linux rpm 提权安装 argv 纯函数。
pub fn rpm_install_argv(path: &Path) -> Vec<String> {
    vec![
        "pkexec".to_string(),
        "rpm".to_string(),
        "-i".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

/// AppImage 赋权 argv 纯函数。
pub fn appimage_chmod_argv(path: &Path) -> Vec<String> {
    vec![
        "chmod".to_string(),
        "+x".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

/// AppImage 启动 argv 纯函数（单元素：路径本身）。
pub fn appimage_launch_argv(path: &Path) -> Vec<String> {
    vec![path.to_string_lossy().to_string()]
}

/// Linux AppImage 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_appimage(installer_path: &Path) -> Result<InstallOutcome, String> {
    let chmod_argv = appimage_chmod_argv(installer_path);
    let _ = tokio::process::Command::new(&chmod_argv[0])
        .args(&chmod_argv[1..])
        .status()
        .await;
    let launch_argv = appimage_launch_argv(installer_path);
    let status = tokio::process::Command::new(&launch_argv[0])
        .status()
        .await
        .map_err(|e| format!("启动 AppImage 失败: {}", e))?;
    if status.success() {
        Ok(InstallOutcome::Installed(
            "已赋予可执行权限并启动 AppImage".to_string(),
        ))
    } else {
        Err("AppImage 执行未正常退出".to_string())
    }
}

/// Linux deb 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_deb(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = deb_install_argv(installer_path);
    let status = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .await
        .map_err(|e| format!("调起 pkexec dpkg 失败: {}", e))?;
    if status.success() {
        Ok(InstallOutcome::Installed("deb 包安装已完成".to_string()))
    } else {
        Err("deb 包提权安装未完成或被取消".to_string())
    }
}

/// Linux rpm 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_rpm(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = rpm_install_argv(installer_path);
    let status = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .await
        .map_err(|e| format!("调起 pkexec rpm 失败: {}", e))?;
    if status.success() {
        Ok(InstallOutcome::Installed("rpm 包安装已完成".to_string()))
    } else {
        Err("rpm 包提权安装未完成或被取消".to_string())
    }
}
