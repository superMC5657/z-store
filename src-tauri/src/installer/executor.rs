use super::AssetKind;
use std::fs::File;
use std::path::Path;

#[path = "executor_linux.rs"]
pub mod linux;
#[path = "executor_macos.rs"]
pub mod macos;
#[path = "executor_portable.rs"]
pub mod portable;
#[path = "executor_uninstall.rs"]
pub mod uninstall;
#[path = "executor_windows.rs"]
pub mod windows;

pub use uninstall::{execute_uninstallation, parse_uninstaller_command};

/// 判断是否属于用户主动取消安装流程
/// B1-G7 SSOT：取消谓词唯一来源（回滚点：保持 19-26 行判定语义不动），
/// 卸载侧（executor_uninstall）直接复用，禁止本地副本。
pub(crate) fn is_user_cancellation(reason: &str) -> bool {
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
    haystack.windows(needle_lower.len()).any(|w| {
        w.iter()
            .zip(needle_lower.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
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
/// 与 MSI 行为对齐：setup_exe 无 NSIS/Inno 引擎可调用，exe 本体即安装器，
/// 一律返回空（不带静默参数直接拉起），由其自带向导控制流程（可见进度、可取消），
/// 调用方 `.wait()` 等待完成。嗅探/分类逻辑不动，仅参数变化。
pub fn silent_args_for_setup_kind(kind: &SetupKind) -> Vec<String> {
    match kind {
        SetupKind::Nsis => Vec::new(),
        SetupKind::Inno => Vec::new(),
        SetupKind::Unknown => Vec::new(),
    }
}

/// B3-G6 argv 统一执行入口：deb/rpm/pkg/dmg 共用，防空 argv 索引越界 panic。
/// 纯透传 `argv[0]` 为程序、`argv[1..]` 为参数；argv 组装仍由各纯函数负责（SSOT 不动）。
/// 调用方自行叠加业务上下文（见各 install_* 的 map_err），此处仅透传 io 错误文本。
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) async fn run_argv(argv: &[String]) -> Result<std::process::ExitStatus, String> {
    let (prog, args) = argv
        .split_first()
        .ok_or_else(|| "空 argv：拒绝执行".to_string())?;
    tokio::process::Command::new(prog)
        .args(args)
        .status()
        .await
        .map_err(|e| e.to_string())
}

/// 安装执行入口：成功 info / 正常取消 info / 异常失败 error。
pub async fn execute_installation(
    installer_path: &Path,
    kind: &AssetKind,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    log::info!(
        "install start sid={} id={} kind={:?}",
        crate::z_log::new_session_id(),
        app_id,
        kind
    );
    let res = execute_installation_inner(installer_path, kind, app_id, custom_portable_dir).await;
    match &res {
        Ok(InstallOutcome::Installed(_)) => {
            log::info!(
                "install done sid={} id={}",
                crate::z_log::new_session_id(),
                app_id
            )
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

fn platform_skipped(desc: &str, path: &Path) -> Result<InstallOutcome, String> {
    Ok(InstallOutcome::Skipped(format!("{}: {:?}", desc, path)))
}

macro_rules! run_on_target {
    (windows => $run:expr, skip => $msg:expr, $path:expr) => {{
        #[cfg(target_os = "windows")]
        {
            $run
        }
        #[cfg(not(target_os = "windows"))]
        {
            platform_skipped($msg, $path)
        }
    }};
    (macos => $run:expr, skip => $msg:expr, $path:expr) => {{
        #[cfg(target_os = "macos")]
        {
            $run
        }
        #[cfg(not(target_os = "macos"))]
        {
            platform_skipped($msg, $path)
        }
    }};
    (linux => $run:expr, skip => $msg:expr, $path:expr) => {{
        #[cfg(target_os = "linux")]
        {
            $run
        }
        #[cfg(not(target_os = "linux"))]
        {
            platform_skipped($msg, $path)
        }
    }};
}

async fn execute_installation_inner(
    installer_path: &Path,
    kind: &AssetKind,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    match kind {
        AssetKind::Msi => run_on_target!(
            windows => windows::install_msi(installer_path, app_id).await,
            skip => "当前平台跳过 MSI 安装", installer_path
        ),
        AssetKind::SetupExe => run_on_target!(
            windows => windows::install_setup_exe(installer_path, app_id).await,
            skip => "非 Windows 平台跳过 SetupExe 安装", installer_path
        ),
        AssetKind::PortableZip => {
            portable::install_portable_zip(installer_path, app_id, custom_portable_dir)
        }
        AssetKind::PortableTarball => {
            portable::install_portable_tarball(installer_path, app_id, custom_portable_dir)
        }
        AssetKind::Dmg => run_on_target!(
            macos => macos::install_dmg(installer_path).await,
            skip => "非 macOS 平台跳过 DMG 挂载与解构安装", installer_path
        ),
        AssetKind::Pkg => run_on_target!(
            macos => macos::install_pkg(installer_path).await,
            skip => "非 macOS 平台跳过 PKG 安装", installer_path
        ),
        AssetKind::AppImage => run_on_target!(
            linux => linux::install_appimage(installer_path).await,
            skip => "非 Linux 平台跳过 AppImage 执行", installer_path
        ),
        AssetKind::Deb => run_on_target!(
            linux => linux::install_deb(installer_path).await,
            skip => "非 Linux 平台跳过 deb 安装", installer_path
        ),
        AssetKind::Rpm => run_on_target!(
            linux => linux::install_rpm(installer_path).await,
            skip => "非 Linux 平台跳过 rpm 安装", installer_path
        ),
        _ => run_on_target!(
            windows => windows::install_fallback_default(installer_path).await,
            skip => "当前平台跳过系统默认处理程序拉起", installer_path
        ),
    }
}
