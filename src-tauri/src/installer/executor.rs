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
/// 取消谓词唯一来源（SSOT：判定语义保持不变），
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

/// 扫描安装程序头部字节嗅探安装器类型（NSIS / Inno / Unknown）。
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

/// 返回安装器启动参数：由安装器自带交互式向导控制流程与取消。
pub fn silent_args_for_setup_kind(kind: &SetupKind) -> Vec<String> {
    match kind {
        SetupKind::Nsis => Vec::new(),
        SetupKind::Inno => Vec::new(),
        SetupKind::Unknown => Vec::new(),
    }
}

/// argv 统一执行入口：deb/rpm/pkg/dmg 共用，防空 argv 索引越界 panic。
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
    let started = std::time::Instant::now();
    let trace = crate::z_log::new_trace_id();
    let kind_str = format!("{:?}", kind);
    let mut start_ev = crate::z_log::WideEvent::new("installer", "install start");
    start_ev
        .field("id", app_id)
        .field("kind", &kind_str)
        .field("t", &trace)
        .dev(
            "file",
            crate::log_support::file_base(&installer_path.to_string_lossy()),
        );
    start_ev.info();

    let res = execute_installation_inner(installer_path, kind, app_id, custom_portable_dir).await;
    match &res {
        Ok(InstallOutcome::Installed(_)) => {
            let mut ev =
                crate::z_log::WideEvent::new("installer", "install done").with_started(started);
            ev.field("id", app_id)
                .field("kind", &kind_str)
                .field("t", &trace);
            ev.info();
        }
        Ok(InstallOutcome::Skipped(msg)) => {
            let mut ev =
                crate::z_log::WideEvent::new("installer", "install skipped").with_started(started);
            ev.field("id", app_id)
                .field("kind", &kind_str)
                .field("reason", crate::log_support::short_reason(msg))
                .field("t", &trace);
            ev.info();
        }
        Err(e) if is_user_cancellation(e) => {
            let mut ev = crate::z_log::WideEvent::new("installer", "install cancelled")
                .with_started(started);
            ev.field("id", app_id)
                .field("kind", &kind_str)
                .field("t", &trace)
                .dev("reason", crate::log_support::short_reason(e));
            ev.info();
        }
        Err(e) => {
            let mut ev =
                crate::z_log::WideEvent::new("installer", "install failed").with_started(started);
            ev.field("id", app_id)
                .field("kind", &kind_str)
                .field("reason", crate::log_support::short_reason(e))
                .field("t", &trace);
            ev.error();
        }
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

fn owned_portable_args(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> (std::path::PathBuf, String, Option<String>) {
    (
        installer_path.to_path_buf(),
        app_id.to_string(),
        custom_portable_dir.map(str::to_string),
    )
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
            windows => windows::install_setup_exe(installer_path).await,
            skip => "非 Windows 平台跳过 SetupExe 安装", installer_path
        ),
        // 同步解压与桌面快捷方式创建（PowerShell）卸到阻塞线程池，不占用异步运行时线程。
        AssetKind::PortableZip => {
            let (path, id, dir) = owned_portable_args(installer_path, app_id, custom_portable_dir);
            tokio::task::spawn_blocking(move || {
                portable::install_portable_zip(&path, &id, dir.as_deref())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        AssetKind::PortableTarball => {
            let (path, id, dir) = owned_portable_args(installer_path, app_id, custom_portable_dir);
            tokio::task::spawn_blocking(move || {
                portable::install_portable_tarball(&path, &id, dir.as_deref())
            })
            .await
            .map_err(|e| e.to_string())?
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
