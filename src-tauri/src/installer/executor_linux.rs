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

/// `rpm -ql <pkg>` 查询 argv 纯函数（rpm 回填用；供单测锁定）。
pub fn rpm_list_argv(pkg: &str) -> Vec<String> {
    vec![
        "rpm".to_string(),
        "-ql".to_string(),
        pkg.trim().to_string(),
    ]
}

/// 解析 `.desktop` Exec 行为二进制（去 `%U/%F` 等字段码、引号、`env VAR=..` 前缀）。
/// 纯函数，跨平台可单测；真实实现收敛于 `scanner::AppScanner::parse_desktop_exec_binary`，
/// 此处保留轻量转发，避免 installer ↔ scanner 循环依赖感知扩散。
pub fn parse_desktop_exec_binary(exec_line: &str) -> Option<String> {
    crate::scanner::AppScanner::parse_desktop_exec_binary(exec_line)
}

/// `strip` 语义别名：去掉 Exec 行的参数与字段码，仅保留二进制部分（供调用方日志/诊断用）。
pub fn strip_desktop_exec_args(exec_line: &str) -> String {
    parse_desktop_exec_binary(exec_line).unwrap_or_else(|| exec_line.trim().to_string())
}

/// 从包文件列表输出中挑选可执行文件（纯函数，可单测；`dpkg -L` / `rpm -ql` 共用）。
pub fn pick_executable_from_file_list(output: &str, candidates: &[String]) -> Option<String> {
    crate::scanner::AppScanner::pick_executable_from_package_list(output, candidates)
}

/// deb 安装后回填：对候选包名执行 `dpkg -L` 并挑选可执行文件；失败返回 None（调用方继续走
/// which/desktop 嗅探）。仅 Linux 编译；非 Linux 返回 None 且不执行任何进程。
pub fn resolve_deb_installed_path(
    package_names: &[String],
    candidates: &[String],
) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        for pkg in package_names {
            let p = pkg.trim();
            if p.is_empty() {
                continue;
            }
            let argv = dpkg_list_argv(p);
            let (prog, args) = argv.split_first()?;
            let output = std::process::Command::new(prog).args(args).output().ok()?;
            if !output.status.success() {
                continue;
            }
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if let Some(picked) = pick_executable_from_file_list(&text, candidates) {
                let path = Path::new(&picked);
                if path.is_file() {
                    let resolved =
                        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                    return Some(resolved.to_string_lossy().to_string());
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (package_names, candidates);
        None
    }
}

/// desktop 文件回填：扫描系统 `.desktop` 的 `Exec=` 并解析为落盘路径。
/// 仅 Linux 编译；非 Linux 返回 None。
pub fn resolve_desktop_installed_path(bare_names: &[String]) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        use std::path::PathBuf;
        let mut dirs: Vec<PathBuf> = vec![
            PathBuf::from("/usr/share/applications"),
            PathBuf::from("/usr/local/share/applications"),
        ];
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(home).join(".local/share/applications"));
        }
        // 先按文件名精准命中
        for dir in &dirs {
            for name in bare_names {
                let n = name.trim().to_lowercase();
                if n.is_empty() {
                    continue;
                }
                let p = dir.join(format!("{}.desktop", n));
                if p.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        for line in content.lines() {
                            let t = line.trim();
                            if t.starts_with("Exec=") {
                                if let Some(bin) = parse_desktop_exec_binary(t) {
                                    if let Some(r) =
                                        crate::scanner::AppScanner::resolve_binary_via_path(
                                            &bin,
                                        )
                                    {
                                        return Some(r);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // 文件名未命中时遍历匹配 Name=/Exec 含 token 的文件
        for dir in &dirs {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file()
                    || p.extension().is_none_or(|e| !e.eq_ignore_ascii_case("desktop"))
                {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&p) else {
                    continue;
                };
                let lower = content.to_lowercase();
                let hit = bare_names.iter().any(|n| {
                    let nl = n.trim().to_lowercase();
                    !nl.is_empty() && lower.contains(&nl)
                });
                if !hit {
                    continue;
                }
                for line in content.lines() {
                    let t = line.trim();
                    if t.starts_with("Exec=") {
                        if let Some(bin) = parse_desktop_exec_binary(t) {
                            if let Some(r) =
                                crate::scanner::AppScanner::resolve_binary_via_path(&bin)
                            {
                                return Some(r);
                            }
                        }
                    }
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = bare_names;
        None
    }
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
