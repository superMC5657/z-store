use super::{InstallOutcome, is_user_cancellation};

/// 智能拆分 Windows 卸载命令行为 (可执行文件路径, 参数列表)
pub fn parse_uninstaller_command(cmd: &str) -> (String, Vec<String>) {
    let trimmed = cmd.trim();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end_idx) = stripped.find('"') {
            let exe = stripped[..end_idx].to_string();
            let args_part = stripped[end_idx + 1..].trim();
            let args = if args_part.is_empty() {
                Vec::new()
            } else {
                args_part
                    .split_whitespace()
                    .map(|s| s.to_string())
                    .collect()
            };
            return (exe, args);
        }
    }

    let lower = trimmed.to_lowercase();
    if lower.starts_with("msiexec") {
        if let Some(space_idx) = trimmed.find(' ') {
            let exe = trimmed[..space_idx].to_string();
            let args = trimmed[space_idx..]
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            return (exe, args);
        }
    }

    if let Some(space_idx) = trimmed.find(' ') {
        let exe = trimmed[..space_idx].to_string();
        if std::path::Path::new(&exe).is_file() {
            let args = trimmed[space_idx..]
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            return (exe, args);
        }
    }

    (trimmed.to_string(), Vec::new())
}
#[cfg(target_os = "windows")]
fn is_nsis_uninstaller(exe_str: &str) -> bool {
    let path = std::path::Path::new(exe_str);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Inno Setup 的标准卸载程序是 unins000.exe / unins001.exe，它原生同步等待且不接受 _?=
    if name.starts_with("unins000") || name.starts_with("unins001") {
        return false;
    }

    // 常见的 NSIS 卸载程序命名特征 (如 "Uninstall PicGo.exe", "uninstall.exe")
    if name.starts_with("uninstall") || name == "uninst.exe" || name.starts_with("unins_") {
        return true;
    }

    // 检查二进制内容中是否有 NullsoftInst 签名
    if let Ok(mut file) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 262144];
        if let Ok(n) = file.read(&mut buf) {
            if buf[..n].windows(12).any(|w| w == b"NullsoftInst") {
                return true;
            }
        }
    }

    false
}

#[cfg(target_os = "windows")]
fn path_or_dir_still_has_app(target: &std::path::Path) -> bool {
    if !target.exists() {
        return false;
    }
    if target.is_file() {
        return true;
    }
    if target.is_dir() {
        // 如果给定的目录仍存在，检查是否还包含任何 .exe 可执行文件
        if let Ok(entries) = std::fs::read_dir(target) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn is_file_locked(path: &std::path::Path) -> bool {
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(_) => false,
        Err(e) => e.raw_os_error() == Some(32) || e.kind() == std::io::ErrorKind::PermissionDenied,
    }
}

#[cfg(target_os = "windows")]
fn find_running_nsis_temp_exe() -> Option<std::path::PathBuf> {
    let temp_dir = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                if name.starts_with("~nsu") {
                    if let Ok(sub_entries) = std::fs::read_dir(&p) {
                        for sub in sub_entries.flatten() {
                            let sub_p = sub.path();
                            if sub_p.is_file() {
                                if let Some(ext) = sub_p.extension() {
                                    if ext.eq_ignore_ascii_case("exe") && is_file_locked(&sub_p) {
                                        return Some(sub_p);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}
/// 执行官方卸载向导并异步挂起等待用户操作完成，随后核验卸载状态
/// B1-G7 收敛：取消判定复用 `super::is_user_cancellation`（SSOT），
/// 成功经 `InstallOutcome::Installed(..).into_result()` 收敛为 `Ok(())`；
/// 本文件不保留本地取消谓词/退出码映射副本。
pub async fn execute_uninstallation(
    uninstaller_cmd: &str,
    main_install_path: &str,
    app_name: &str,
) -> Result<(), String> {
    let res =
        execute_uninstallation_inner(uninstaller_cmd, main_install_path, app_name).await;
    match &res {
        Ok(InstallOutcome::Installed(_)) => {
            log::info!("uninstall done id={}", app_name)
        }
        Ok(InstallOutcome::Skipped(msg)) => log::info!(
            "uninstall skipped id={} reason={}",
            app_name,
            crate::log_support::short_reason(msg)
        ),
        Err(e) if is_user_cancellation(e) => {
            log::info!(
                "uninstall cancelled by user id={} reason={}",
                app_name,
                crate::log_support::short_reason(e)
            );
        }
        Err(e) => log::error!(
            "uninstall failed id={} reason={}",
            app_name,
            crate::log_support::short_reason(e)
        ),
    }
    match res {
        Ok(outcome) => outcome.into_result().map(|_| ()),
        Err(e) => Err(e),
    }
}

async fn execute_uninstallation_inner(
    uninstaller_cmd: &str,
    main_install_path: &str,
    app_name: &str,
) -> Result<InstallOutcome, String> {
    #[cfg(target_os = "windows")]
    {
        use std::time::Duration;

        let (exe, args) = parse_uninstaller_command(uninstaller_cmd);

        let is_lnk = exe.to_lowercase().ends_with(".lnk");

        let status = if is_lnk {
            let mut child = tokio::process::Command::new("cmd.exe")
                .args(["/C", "start", "/WAIT", "", &exe])
                .spawn()
                .map_err(|e| format!("启动卸载快捷方式失败 ({}): {}", exe, e))?;
            child
                .wait()
                .await
                .map_err(|e| format!("快捷方式执行异常: {}", e))?
        } else {
            let is_nsis = is_nsis_uninstaller(&exe);
            let mut std_cmd = std::process::Command::new(&exe);
            std_cmd.args(&args);

            let mut cmd = tokio::process::Command::from(std_cmd);
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("无法调起 {} 的官方卸载程序 ({}): {}", app_name, exe, e))?;
            let exit_status = child
                .wait()
                .await
                .map_err(|e| format!("卸载向导运行异常: {}", e))?;

            // 关键机制：NSIS 卸载向导会复制自身到 %TEMP%\~nsu.tmp\Un_A.exe 或 Au_.exe 并退出原进程，
            // 绝不能对 electron-builder/NSIS 程序强加 `_?=` 参数，否则其内置的 PowerShell 进程探测
            // 会误将自身视作正在运行的主应用并弹出“应用正在运行中”假报错。
            // 此处让 NSIS 正常释放到 %TEMP%，并通过独占文件锁检测异步挂起等待其在 Temp 中真正运行完毕。
            if is_nsis {
                let mut temp_uninstaller = None;
                for _ in 0..20 {
                    if let Some(temp_exe) = find_running_nsis_temp_exe() {
                        temp_uninstaller = Some(temp_exe);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }

                if let Some(temp_exe) = temp_uninstaller {
                    while is_file_locked(&temp_exe) && temp_exe.exists() {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            }

            exit_status
        };

        // 异步等待系统释放文件句柄与后台清理
        tokio::time::sleep(Duration::from_millis(800)).await;

        // 双重核验（Double-Check）：核验主程序文件是否已被删除
        let exe_path = std::path::Path::new(main_install_path);
        let has_target_path = !main_install_path.is_empty();

        if has_target_path && path_or_dir_still_has_app(exe_path) {
            // 给系统与卸载清理 1.5 秒缓冲轮询（针对耗时较长的文件删除动作）
            let mut still_exists = true;
            for _ in 0..3 {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !path_or_dir_still_has_app(exe_path) {
                    still_exists = false;
                    break;
                }
            }

            if still_exists {
                let code = status.code().unwrap_or(-1);
                return Err(format!(
                    "应用主程序仍完好存在（退出代码: {}），卸载向导已被用户取消或尚未完成",
                    code
                ));
            }
        } else if !status.success() {
            let code = status.code().unwrap_or(-1);
            return Err(format!("卸载向导异常退出或被用户取消 (退出代码: {})", code));
        }

        Ok(InstallOutcome::Installed("卸载已完成".to_string()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let (exe, args) = parse_uninstaller_command(uninstaller_cmd);
        if exe.trim().is_empty() {
            return Err("卸载命令为空，已拒绝执行".to_string());
        }
        let mut child = tokio::process::Command::new(&exe)
            .args(&args)
            .spawn()
            .map_err(|e| format!("执行卸载脚本失败: {}", e))?;
        let status = child
            .wait()
            .await
            .map_err(|e| format!("卸载进程异常: {}", e))?;
        if status.success() {
            Ok(InstallOutcome::Installed("卸载已完成".to_string()))
        } else {
            Err(format!("卸载未能成功完成 (退出代码: {:?})", status.code()))
        }
    }
}
