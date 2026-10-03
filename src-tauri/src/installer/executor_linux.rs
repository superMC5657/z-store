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
    let _ = super::run_argv(&chmod_argv).await;
    let launch_argv = appimage_launch_argv(installer_path);
    let status = super::run_argv(&launch_argv)
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

#[cfg(target_os = "linux")]
async fn run_pkexec_package_installer(
    argv: &[String],
    tool_label: &str,
    pkg_kind: &str,
) -> Result<InstallOutcome, String> {
    let status = super::run_argv(argv)
        .await
        .map_err(|e| format!("调起 pkexec {} 失败: {}", tool_label, e))?;
    if status.success() {
        Ok(InstallOutcome::Installed(format!("{} 包安装已完成", pkg_kind)))
    } else {
        Err(format!("{} 包提权安装未完成或被取消", pkg_kind))
    }
}

/// Linux deb 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_deb(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = deb_install_argv(installer_path);
    run_pkexec_package_installer(&argv, "dpkg", "deb").await
}

/// Linux rpm 安装体（原 executor.rs 内联 cfg(linux) 分支纯移动）。
#[cfg(target_os = "linux")]
pub async fn install_rpm(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = rpm_install_argv(installer_path);
    run_pkexec_package_installer(&argv, "rpm", "rpm").await
}
