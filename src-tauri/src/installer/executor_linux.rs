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

/// `dpkg -L <pkg>` 查询 argv 纯函数（deb 安装后回填落盘路径用；供单测锁定）。
pub fn dpkg_list_argv(pkg: &str) -> Vec<String> {
    vec![
        "dpkg".to_string(),
        "-L".to_string(),
        pkg.trim().to_string(),
    ]
}

/// `rpm -ql <pkg>` 查询 argv 纯函数（rpm 回填用；供单测锁定；经 `resolve_rpm_installed_path` 接线）。
pub fn rpm_list_argv(pkg: &str) -> Vec<String> {
    vec![
        "rpm".to_string(),
        "-ql".to_string(),
        pkg.trim().to_string(),
    ]
}

/// 包文件列表查询通用体（`dpkg -L` / `rpm -ql` 共用，列表 argv 构造器注入；
/// 挑选 + 规范化收敛于 `scanner::AppScanner::pick_and_canonicalize_package_path`）。
/// 对候选包名逐个执行列表命令并精准挑选；失败返回 None（调用方继续走 which/desktop 嗅探）。
/// 仅 Linux 执行进程；非 Linux 返回 None 且不执行任何进程。
fn resolve_via_pkg_manager(
    package_names: &[String],
    candidates: &[String],
    list_argv: fn(&str) -> Vec<String>,
) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        for pkg in package_names {
            let p = pkg.trim();
            if p.is_empty() {
                continue;
            }
            let argv = list_argv(p);
            let (prog, args) = argv.split_first()?;
            let output = std::process::Command::new(prog).args(args).output().ok()?;
            if !output.status.success() {
                continue;
            }
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if let Some(found) =
                crate::scanner::AppScanner::pick_and_canonicalize_package_path(&text, candidates)
            {
                return Some(found);
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (package_names, candidates, list_argv);
        None
    }
}

/// deb 安装后回填：对候选包名执行 `dpkg -L` 并精准挑选可执行文件；失败返回 None
/// （调用方继续走 which/desktop 嗅探）。仅 Linux 编译；非 Linux 返回 None 且不执行任何进程。
pub fn resolve_deb_installed_path(
    package_names: &[String],
    candidates: &[String],
) -> Option<String> {
    resolve_via_pkg_manager(package_names, candidates, dpkg_list_argv)
}

/// rpm 安装后回填：对候选包名执行 `rpm -ql` 并精准挑选可执行文件；失败返回 None。
/// 与 deb 共用查询通用体（`rpm_list_argv` 在此接线，消零调用）。
/// 仅 Linux 编译；非 Linux 返回 None 且不执行任何进程。
pub fn resolve_rpm_installed_path(
    package_names: &[String],
    candidates: &[String],
) -> Option<String> {
    resolve_via_pkg_manager(package_names, candidates, rpm_list_argv)
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
