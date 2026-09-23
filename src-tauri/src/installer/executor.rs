use super::AssetKind;
use std::fs::File;
use std::path::Path;

#[path = "executor_windows.rs"]
pub mod windows;
#[path = "executor_macos.rs"]
pub mod macos;
#[path = "executor_linux.rs"]
pub mod linux;
#[path = "executor_portable.rs"]
pub mod portable;
#[path = "executor_uninstall.rs"]
pub mod uninstall;

pub use uninstall::{execute_uninstallation, parse_uninstaller_command};

/// 判断是否属于用户主动取消安装流程
fn is_user_cancellation(reason: &str) -> bool {
    reason.contains("用户取消")
        || reason.contains("被取消")
        || reason.contains("安装已中止")
        || reason.contains("cancelled")
        || reason.contains("canceled")
        || reason.contains("1602")
}

/// 安装执行结果：平台跳过是全量 no-op，必须是结构化的非成功信号，
/// 调用方将其映射为"未安装"（绝不落库为已安装），保持文案人类可读。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed(String),
    Skipped(String),
}

impl InstallOutcome {
    /// `Installed` ⇒ `Ok`；`Skipped` ⇒ `Err`（非成功，调用方 `?` 直接中断、不落库）。
    pub fn into_result(self) -> Result<String, String> {
        match self {
            InstallOutcome::Installed(msg) => Ok(msg),
            InstallOutcome::Skipped(msg) => Err(msg),
        }
    }
}

/// Windows SetupExe 安装器类型：仅做 PE 字符串/版本信息嗅探，不做猜测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupKind {
    Nsis,
    Inno,
    Unknown,
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn bytes_contain_ascii_insensitive(haystack: &[u8], needle_lower: &[u8]) -> bool {
    if needle_lower.is_empty() || haystack.len() < needle_lower.len() {
        return false;
    }
    haystack
        .windows(needle_lower.len())
        .any(|w| w.iter().zip(needle_lower.iter()).all(|(a, b)| a.to_ascii_lowercase() == *b))
}

/// 纯嗅探：扫描二进制中的安装器签名标记（不启动任何进程，可单元测试）。
/// - NSIS ⇒ 含 `NullsoftInst`（与卸载侧 `is_nsis_uninstaller` 同一标记）；
/// - Inno Setup ⇒ 含 `Inno Setup` / `InnoSetup` / `JR.Inno`（版本信息与节签名）；
/// - 其余 ⇒ `Unknown`（调用方走现有交互式行为 + 日志，绝不猜测静默参数）。
pub fn sniff_setup_kind(bytes: &[u8]) -> SetupKind {
    if bytes_contain(bytes, b"NullsoftInst") {
        return SetupKind::Nsis;
    }
    if bytes_contain_ascii_insensitive(bytes, b"inno setup")
        || bytes_contain(bytes, b"InnoSetup")
        || bytes_contain_ascii_insensitive(bytes, b"jr.inno")
    {
        return SetupKind::Inno;
    }
    SetupKind::Unknown
}

/// 从文件嗅探安装器类型：仅读取头部字节做字符串扫描；读取失败 ⇒ `Unknown`。
pub fn sniff_setup_kind_from_file(path: &Path) -> SetupKind {
    use std::io::Read;
    match File::open(path) {
        Ok(mut f) => {
            let mut buf = [0u8; 262144];
            match f.read(&mut buf) {
                Ok(0) => SetupKind::Unknown,
                Ok(n) => sniff_setup_kind(&buf[..n]),
                Err(_) => SetupKind::Unknown,
            }
        }
        Err(_) => SetupKind::Unknown,
    }
}

/// 安装器类型 ⇒ 静默参数映射（纯函数，可单元测试）。
/// 未知类型返回空（调用方走交互式回退，绝不猜测）。
pub fn silent_args_for_setup_kind(kind: &SetupKind) -> Vec<String> {
    match kind {
        SetupKind::Nsis => vec!["/S".to_string()],
        SetupKind::Inno => vec!["/VERYSILENT".to_string(), "/NORESTART".to_string()],
        SetupKind::Unknown => Vec::new(),
    }
}

/// 安装执行入口：成功 info / 正常取消 info / 异常失败 error。
pub async fn execute_installation(
    installer_path: &Path,
    kind: &AssetKind,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    log::info!("install start sid={} id={} kind={:?}", crate::z_log::new_session_id(), app_id, kind);
    let res =
        execute_installation_inner(installer_path, kind, app_id, custom_portable_dir).await;
    match &res {
        Ok(InstallOutcome::Installed(_)) => {
            log::info!("install done sid={} id={}", crate::z_log::new_session_id(), app_id)
        }
        Ok(InstallOutcome::Skipped(msg)) => log::info!(
            "install skipped sid={} id={} reason={}",
            crate::z_log::new_session_id(),
            app_id,
            crate::log_support::short_reason(msg)
        ),
        Err(e) if is_user_cancellation(e) => {
            log::info!(
                "install cancelled by user sid={} id={} reason={}",
                crate::z_log::new_session_id(),
                app_id,
                crate::log_support::short_reason(e)
            );
        }
        Err(e) => log::error!(
            "install failed id={} reason={}",
            app_id,
            crate::log_support::short_reason(e)
        ),
    }
    res
}

async fn execute_installation_inner(
    installer_path: &Path,
    kind: &AssetKind,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    match kind {
        AssetKind::Msi => {
            #[cfg(target_os = "windows")]
            {
                windows::install_msi(installer_path, app_id).await
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "当前平台跳过 MSI 安装: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::SetupExe => {
            #[cfg(target_os = "windows")]
            {
                windows::install_setup_exe(installer_path, app_id).await
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 Windows 平台跳过 SetupExe 安装: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::PortableZip => {
            portable::install_portable_zip(installer_path, app_id, custom_portable_dir)
        }
        AssetKind::Dmg => {
            #[cfg(target_os = "macos")]
            {
                macos::install_dmg(installer_path).await
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 macOS 平台跳过 DMG 挂载与解构安装: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::Pkg => {
            #[cfg(target_os = "macos")]
            {
                macos::install_pkg(installer_path).await
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 macOS 平台跳过 PKG 安装: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::AppImage => {
            #[cfg(target_os = "linux")]
            {
                linux::install_appimage(installer_path).await
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 Linux 平台跳过 AppImage 执行: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::Deb => {
            #[cfg(target_os = "linux")]
            {
                linux::install_deb(installer_path).await
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 Linux 平台跳过 deb 安装: {:?}",
                    installer_path
                )))
            }
        }
        AssetKind::Rpm => {
            #[cfg(target_os = "linux")]
            {
                linux::install_rpm(installer_path).await
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "非 Linux 平台跳过 rpm 安装: {:?}",
                    installer_path
                )))
            }
        }
        _ => {
            #[cfg(target_os = "windows")]
            {
                windows::install_fallback_default(installer_path).await
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(InstallOutcome::Skipped(format!(
                    "当前平台跳过系统默认处理程序拉起: {:?}",
                    installer_path
                )))
            }
        }
    }
}

pub fn build_unix_install_commands(kind: &AssetKind, asset_path: &Path) -> Vec<Vec<String>> {
    let p = asset_path.to_string_lossy().to_string();
    match kind {
        AssetKind::Dmg => vec![
            vec!["hdiutil".into(), "attach".into(), "-nobrowse".into(), "-readonly".into(), p],
            vec!["cp".into(), "-R".into(), "/Volumes/<App>/<App>.app".into(), "/Applications/".into()],
            vec!["hdiutil".into(), "detach".into(), "/Volumes/<App>".into(), "-force".into()],
        ],
        AssetKind::Pkg => vec![
            vec!["installer".into(), "-pkg".into(), p, "-target".into(), "CurrentUserHomeDirectory".into()]
        ],
        AssetKind::AppImage => vec![
            vec!["chmod".into(), "+x".into(), p.clone()],
            vec![p],
        ],
        AssetKind::Deb => vec![
            vec!["pkexec".into(), "dpkg".into(), "-i".into(), p]
        ],
        AssetKind::Rpm => vec![
            vec!["pkexec".into(), "rpm".into(), "-i".into(), p]
        ],
        AssetKind::Apk => vec![
            vec!["pm".into(), "install".into(), "-r".into(), p]
        ],
        _ => vec![],
    }
}

