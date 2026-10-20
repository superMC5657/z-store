#[cfg(target_os = "windows")]
use super::{silent_args_for_setup_kind, sniff_setup_kind_from_file, InstallOutcome};
#[cfg(target_os = "windows")]
use std::path::Path;

/// Windows MSI 安装体（原 executor.rs 内联 cfg(windows) 分支纯移动）。
#[cfg(target_os = "windows")]
pub async fn install_msi(installer_path: &Path, app_id: &str) -> Result<InstallOutcome, String> {
    use std::time::Duration;
    // 跳过系统还原点创建（MSIFASTINSTALL=7）：应用商店高频安装场景下，
    // 每个 MSI 都建还原点动辄十几秒；失败回滚仍可走卸载重装。
    // 仅作用于我们拉起的这两个 msiexec 进程，不改系统全局策略。
    let silent_status = tokio::process::Command::new("msiexec.exe")
        .env("MSIFASTINSTALL", "7")
        .arg("/i")
        .arg(installer_path)
        .arg("/qn")
        .arg("/norestart")
        .status()
        .await
        .map_err(|e| format!("调起 MSI 静默安装器失败: {}", e))?;

    if silent_status.success() {
        // 进程退出后给系统落盘（注册表/文件）留 800ms，再嗅探安装路径
        tokio::time::sleep(Duration::from_millis(800)).await;
        return Ok(InstallOutcome::Installed("MSI 静默安装已完成".to_string()));
    }

    let code = silent_status.code().unwrap_or(-1);
    if code == 1602 {
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
        .env("MSIFASTINSTALL", "7")
        .arg("/i")
        .arg(installer_path)
        .spawn()
        .map_err(|e| format!("静默安装被拒绝且拉起 MSI 向导失败: {}", e))?;

    let fallback_status = fallback
        .wait()
        .await
        .map_err(|e| format!("MSI 向导进程异常: {}", e))?;

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
    // 与 MSI 行为对齐：setup_exe 无 NSIS/Inno 引擎可调用（exe 本体即安装器），
    // 不带任何静默参数直接拉起，由其自带向导控制流程（可见进度、可取消），
    // 调用方 `.wait()` 等待用户完成或取消；退出码 1602/1/2 仍映射为用户取消。
    let setup_kind = sniff_setup_kind_from_file(installer_path);
    let silent_args = silent_args_for_setup_kind(&setup_kind);
    log::info!(
        "install setup interactive sid={} kind={:?} id={}",
        crate::z_log::new_session_id(),
        setup_kind,
        app_id
    );
    let mut child = tokio::process::Command::new(installer_path)
        .args(&silent_args)
        .spawn()
        .map_err(|e| format!("调起安装程序失败: {}", e))?;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("安装程序运行异常: {}", e))?;

    tokio::time::sleep(Duration::from_millis(800)).await;

    if status.success() {
        Ok(InstallOutcome::Installed("安装程序已完成".to_string()))
    } else {
        let code = status.code().unwrap_or(-1);
        if code == 1602 || code == 1 || code == 2 {
            Err(format!(
                "用户取消了安装向导或安装已中止 (退出代码: {})",
                code
            ))
        } else {
            Err(format!("安装程序未能成功完成 (退出代码: {})", code))
        }
    }
}

/// Windows 通用回退安装体（`_` 分支，cfg(windows) 门控）。
/// 直接以资产路径拉起进程，严禁经 cmd.exe `start` 路由：第三方资产名可能含
/// `"`/`&`/`%` 等元字符，Rust 按 MSVCRT 规则转义为 `\"`，cmd 解析器并不认，
/// 可断开参数注入任意命令；且 `start` 会把首个带引号参数当窗口标题吞掉。
/// `.status()` 自带等待语义，与原 `/wait` 等价。
#[cfg(target_os = "windows")]
pub async fn install_fallback_default(installer_path: &Path) -> Result<InstallOutcome, String> {
    let status = tokio::process::Command::new(installer_path)
        .status()
        .await
        .map_err(|e| format!("调起安装程序失败 ({}): {}", installer_path.display(), e))?;
    if status.success() {
        Ok(InstallOutcome::Installed(
            "安装程序已处理完成".to_string(),
        ))
    } else {
        Err("处理未正常完成".to_string())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod fallback_tests {
    use super::*;

    #[tokio::test]
    async fn fallback_surfaces_spawn_error_for_missing_installer() {
        // 直调路径下缺失资产的 spawn 失败必须如实冒泡为 Err；
        // 若回退经 cmd.exe start，cmd 自身总是被成功拉起，错误与注入面都会被掩盖。
        let missing = std::env::temp_dir().join(format!("zstore-missing-{}.exe", std::process::id()));
        assert!(install_fallback_default(&missing).await.is_err());
    }
}
