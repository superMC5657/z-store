use super::InstallOutcome;
use std::path::Path;

/// 卸载命令行参数分词（轻量 argv）：空白分隔；双引号在任意位置开闭引用段（引号本身剥除，
/// `/LOG="C:\My Logs\u.log"` → `/LOG=C:\My Logs\u.log`）；单引号仅在词首开启引用段，
/// 词中撇号（`O'Brien`）按字面保留。`""` 产出空参数。
fn split_command_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut has_token = false;
    let mut in_double = false;
    let mut in_single = false;
    for c in s.chars() {
        if in_double {
            if c == '"' {
                in_double = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                in_double = true;
                has_token = true;
            }
            '\'' if !has_token => {
                in_single = true;
                has_token = true;
            }
            c if c.is_whitespace() => {
                if has_token {
                    args.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(cur);
    }
    args
}

/// 无引号命令行的可执行后缀断点（优先于任意空格断点）。
const EXECUTABLE_SUFFIXES: &[&str] = &[".exe", ".bat", ".cmd", ".msi", ".com", ".lnk"];

/// 智能拆分 Windows 卸载命令行为 (可执行文件路径, 参数列表)
pub fn parse_uninstaller_command(cmd: &str) -> (String, Vec<String>) {
    let trimmed = cmd.trim();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end_idx) = stripped.find('"') {
            let exe = stripped[..end_idx].to_string();
            let args = split_command_args(&stripped[end_idx + 1..]);
            return (exe, args);
        }
    }

    let lower = trimmed.to_lowercase();
    if lower.starts_with("msiexec") {
        if let Some(space_idx) = trimmed.find(' ') {
            let exe = trimmed[..space_idx].to_string();
            let args = split_command_args(&trimmed[space_idx..]);
            return (exe, args);
        }
    }

    // 未加引号的含空格路径（如 `C:\Program Files\App\unins.exe /SILENT`）：整串即文件则不拆；
    // 否则先找「以可执行后缀结尾且确为文件」的空格断点，再退化到任意「确为文件」的断点。
    if !trimmed.contains(' ') || Path::new(trimmed).is_file() {
        return (trimmed.to_string(), Vec::new());
    }
    let breakpoints: Vec<usize> = trimmed.match_indices(' ').map(|(i, _)| i).collect();
    let split_at = |idx: usize| {
        (
            trimmed[..idx].to_string(),
            split_command_args(&trimmed[idx..]),
        )
    };
    for &idx in &breakpoints {
        let prefix = &trimmed[..idx];
        let prefix_lower = prefix.to_lowercase();
        if EXECUTABLE_SUFFIXES
            .iter()
            .any(|s| prefix_lower.ends_with(s))
            && Path::new(prefix).is_file()
        {
            return split_at(idx);
        }
    }
    for &idx in &breakpoints {
        if Path::new(&trimmed[..idx]).is_file() {
            return split_at(idx);
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

/// `.lnk` 卸载快捷方式放行校验（allowlist）：必须是真实存在的 .lnk 文件，
/// 且不含 shell 元字符。不满足即拒绝执行，报错交用户手动卸载。
#[cfg(target_os = "windows")]
fn validate_lnk_for_launch(exe: &str) -> Result<(), String> {
    const FORBIDDEN: &[char] = &['"', '&', '|', '^', '<', '>', '%', '!', '\n', '\r'];
    if !exe.to_lowercase().ends_with(".lnk") {
        return Err(format!("卸载目标不是 .lnk 快捷方式: {}", exe));
    }
    if !std::path::Path::new(exe).is_file() {
        return Err(format!("卸载快捷方式不存在或不可访问: {}", exe));
    }
    if let Some(c) = exe.chars().find(|c| FORBIDDEN.contains(c)) {
        return Err(format!(
            "卸载快捷方式路径含 shell 元字符 {:?}，已拒绝执行；请在系统设置中手动卸载该应用",
            c
        ));
    }
    Ok(())
}

/// 进程句柄所有权包装：`Drop` 时关闭非空句柄，正常返回、错误提前返回与 Future 取消
/// 走同一条释放路径，无需（也不允许）手动 `CloseHandle`，杜绝泄漏与双重关闭。
/// Windows 内核对象句柄进程级有效、不绑定线程，跨线程共享等待安全；
/// 裸指针默认非 Send/Sync 是 FFI 泛化保守，这里显式放行。
#[cfg(target_os = "windows")]
struct OwnedProcessHandle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(target_os = "windows")]
unsafe impl Send for OwnedProcessHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for OwnedProcessHandle {}

#[cfg(target_os = "windows")]
impl OwnedProcessHandle {
    fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.0
    }
}

#[cfg(target_os = "windows")]
impl Drop for OwnedProcessHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: 句柄由 ShellExecuteExW 返回且仅在此处关闭一次。
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }
}

/// 以 ShellExecuteEx("open") 拉起 .lnk 并等待其进程退出：与 `cmd start /WAIT` 走
/// 同一系统路由，但路径以单个宽字符串直传 shell32，不存在 cmd 元字符解析面。
/// 同步的 `WaitForSingleObject` 以 500ms 切片在阻塞线程池执行，不占用 async worker；
/// 句柄经 `Arc` 共享，任务被取消时由最后一个持有者（含仍在等待的阻塞线程）关闭。
#[cfg(target_os = "windows")]
async fn shell_execute_open_wait(file: &str) -> Result<std::process::ExitStatus, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::ExitStatusExt;
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{GetLastError, WAIT_FAILED, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    // 全部裸指针状态收口在本块内：块内无 await，跨 `.await` 的只有 OwnedProcessHandle。
    let launched: Arc<OwnedProcessHandle> = {
        let file_w = to_wide(file);
        let verb_w = to_wide("open");
        // SAFETY: 全零值对 SHELLEXECUTEINFOW 合法（指针字段为 null）。
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb_w.as_ptr();
        info.lpFile = file_w.as_ptr();
        info.nShow = 1; // SW_SHOWNORMAL

        // SAFETY: info 已初始化，宽字符串缓冲存活到本次调用结束。
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "调起卸载快捷方式失败 (Windows 错误码 {}): {}",
                err, file
            ));
        }
        Arc::new(OwnedProcessHandle(info.hProcess))
    };

    // 处理程序直接委托给已运行实例等场景不回传进程句柄：视作已交由系统处理完成。
    if launched.raw().is_null() {
        return Ok(std::process::ExitStatus::from_raw(0));
    }

    loop {
        let handle = Arc::clone(&launched);
        let (wa, err) = tokio::task::spawn_blocking(move || {
            // SAFETY: Arc 持有期间句柄不会被关闭。
            let wa = unsafe { WaitForSingleObject(handle.raw(), 500) };
            let err = if wa == WAIT_FAILED {
                unsafe { GetLastError() }
            } else {
                0
            };
            (wa, err)
        })
        .await
        .map_err(|e| format!("等待卸载快捷方式进程失败: {}", e))?;
        if wa == WAIT_FAILED {
            return Err(format!("等待卸载快捷方式进程失败 (Windows 错误码 {})", err));
        }
        if wa != WAIT_TIMEOUT {
            break;
        }
    }

    let mut exit_code: u32 = 0;
    // SAFETY: handle 有效且已收到退出信号。
    let got_code = unsafe { GetExitCodeProcess(launched.raw(), &mut exit_code) };
    if got_code == 0 {
        return Err("获取卸载快捷方式进程退出码失败".to_string());
    }
    Ok(std::process::ExitStatus::from_raw(exit_code))
}
/// 执行官方卸载向导并异步挂起等待用户操作完成，随后核验卸载状态
/// 取消判定复用 `super::is_user_cancellation`（SSOT），
/// 成功经 `InstallOutcome::Installed(..).into_result()` 归一为 `Ok(())`；
/// 本文件不持有本地取消谓词/退出码映射副本。
pub async fn execute_uninstallation(
    uninstaller_cmd: &str,
    main_install_path: &str,
    app_name: &str,
) -> Result<(), String> {
    let res = execute_uninstallation_inner(uninstaller_cmd, main_install_path, app_name).await;
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
            // 注册表/DB 来路的卸载串不可信：经 cmd.exe `start /WAIT` 时 `"`/`&`/`%`
            // 等元字符可断开参数注入任意命令。`.lnk` 走 allowlist 校验 + ShellExecuteEx
            // 直调，命令串不经任何 shell 词法解析。
            validate_lnk_for_launch(&exe)?;
            shell_execute_open_wait(&exe).await?
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
                    // 锁等待上限（60s）：临时卸载器被第三方进程长期占用时避免无限
                    // 轮询挂起安装任务，超时报错交用户手动处理。
                    const NSIS_LOCK_WAIT_TIMEOUT_MS: u64 = 60_000;
                    let mut waited_ms: u64 = 0;
                    while is_file_locked(&temp_exe) && temp_exe.exists() {
                        if waited_ms >= NSIS_LOCK_WAIT_TIMEOUT_MS {
                            return Err(format!(
                                "NSIS 临时卸载器仍被占用（已等待 {} 秒）: {}。请关闭相关进程或完成系统卸载向导后重试",
                                NSIS_LOCK_WAIT_TIMEOUT_MS / 1000,
                                temp_exe.display()
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        waited_ms += 500;
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
        let _ = (main_install_path, app_name);
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

#[cfg(test)]
mod parse_uninstaller_tests {
    use super::parse_uninstaller_command;

    #[test]
    fn quoted_path_with_args_splits() {
        let (exe, args) = parse_uninstaller_command(r#""C:\Program Files\App\unins.exe" /S /x=1"#);
        assert_eq!(exe, r"C:\Program Files\App\unins.exe");
        assert_eq!(args, vec!["/S", "/x=1"]);
    }

    #[test]
    fn quoted_path_without_args_has_empty_args() {
        let (exe, args) = parse_uninstaller_command(r#""C:\Program Files\App\unins.exe""#);
        assert_eq!(exe, r"C:\Program Files\App\unins.exe");
        assert!(args.is_empty());
    }

    #[test]
    fn msiexec_splits_without_quotes() {
        let (exe, args) = parse_uninstaller_command("MsiExec.exe /X{ABC-123}");
        assert_eq!(exe, "MsiExec.exe");
        assert_eq!(args, vec!["/X{ABC-123}"]);
    }

    /// 临时目录下建出含空格路径的真实文件，返回 (tempdir 守卫, 文件绝对路径字符串)。
    fn spaced_exe(name: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("Program Files").join("My App");
        std::fs::create_dir_all(&sub).unwrap();
        let exe = sub.join(name);
        std::fs::write(&exe, b"MZ").unwrap();
        let s = exe.to_string_lossy().to_string();
        (dir, s)
    }

    #[test]
    fn unquoted_path_with_spaces_splits_at_executable_suffix() {
        let (_dir, exe_path) = spaced_exe("unins000.exe");
        let (exe, args) = parse_uninstaller_command(&format!("{exe_path} /SILENT /NORESTART"));
        assert_eq!(exe, exe_path);
        assert_eq!(args, vec!["/SILENT", "/NORESTART"]);
    }

    #[test]
    fn unquoted_path_with_spaces_and_no_args_is_kept_whole() {
        let (_dir, exe_path) = spaced_exe("Uninstall My App.exe");
        let (exe, args) = parse_uninstaller_command(&exe_path);
        assert_eq!(exe, exe_path);
        assert!(args.is_empty());
    }

    #[test]
    fn unquoted_spaced_file_name_with_args_splits_after_full_name() {
        let (_dir, exe_path) = spaced_exe("Uninstall My App.exe");
        let (exe, args) = parse_uninstaller_command(&format!("{exe_path} /currentuser"));
        assert_eq!(exe, exe_path);
        assert_eq!(args, vec!["/currentuser"]);
    }

    #[test]
    fn unquoted_extensionless_file_falls_back_to_any_file_breakpoint() {
        let (_dir, exe_path) = spaced_exe("uninstall-script");
        let (exe, args) = parse_uninstaller_command(&format!("{exe_path} --purge"));
        assert_eq!(exe, exe_path);
        assert_eq!(args, vec!["--purge"]);
    }

    #[test]
    fn quoted_args_are_not_split_on_inner_spaces() {
        let (exe, args) = parse_uninstaller_command(
            r#""C:\Program Files\App\unins.exe" /SILENT /LOG="C:\My Logs\u.log" 'two words' "" O'Brien"#,
        );
        assert_eq!(exe, r"C:\Program Files\App\unins.exe");
        assert_eq!(
            args,
            vec![
                "/SILENT",
                r"/LOG=C:\My Logs\u.log",
                "two words",
                "",
                "O'Brien"
            ]
        );
    }

    #[test]
    fn unquoted_path_quoted_args_are_tokenized() {
        let (_dir, exe_path) = spaced_exe("unins.exe");
        let (exe, args) =
            parse_uninstaller_command(&format!(r#"{exe_path} /LOG="C:\My Logs\u.log" /S"#));
        assert_eq!(exe, exe_path);
        assert_eq!(args, vec![r"/LOG=C:\My Logs\u.log", "/S"]);
    }

    #[test]
    fn msiexec_quoted_args_are_tokenized() {
        let (exe, args) =
            parse_uninstaller_command(r#"MsiExec.exe /X{ABC-123} /L*v "C:\My Logs\msi.log""#);
        assert_eq!(exe, "MsiExec.exe");
        assert_eq!(args, vec!["/X{ABC-123}", "/L*v", r"C:\My Logs\msi.log"]);
    }

    #[test]
    fn single_token_returns_whole_string() {
        let (exe, args) = parse_uninstaller_command("just-one-token");
        assert_eq!(exe, "just-one-token");
        assert!(args.is_empty());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod lnk_launch_guard_tests {
    use super::validate_lnk_for_launch;

    #[test]
    fn rejects_metachars_missing_file_and_non_lnk() {
        // 元字符一律拒绝（含经引号断参的注入形态），缺失文件与非 .lnk 目标同样不放行。
        assert!(validate_lnk_for_launch(r#"foo.lnk" & calc & ""#).is_err());
        assert!(validate_lnk_for_launch("a^b.lnk").is_err());
        assert!(validate_lnk_for_launch("a%PATH%b.lnk").is_err());
        assert!(validate_lnk_for_launch("a|b.lnk").is_err());
        assert!(validate_lnk_for_launch("C:\\does\\not\\exist\\uninstall.lnk").is_err());
        assert!(validate_lnk_for_launch("C:\\Windows\\System32\\cmd.exe").is_err());
    }

    #[test]
    fn accepts_existing_lnk_without_metachars() {
        let dir = std::env::temp_dir().join(format!("zstore-lnk-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lnk = dir.join("Uninstall App.lnk");
        std::fs::write(&lnk, b"lnk").unwrap();
        assert!(validate_lnk_for_launch(&lnk.to_string_lossy()).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(all(test, target_os = "windows"))]
mod handle_guard_tests {
    use super::OwnedProcessHandle;
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_HANDLE};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    #[test]
    fn owned_process_handle_null_drop_is_noop() {
        drop(OwnedProcessHandle(std::ptr::null_mut()));
    }

    #[test]
    fn owned_process_handle_closes_kernel_handle_on_final_drop() {
        let raw =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, GetCurrentProcessId()) };
        assert!(!raw.is_null(), "OpenProcess should succeed for current pid");

        let holder = Arc::new(OwnedProcessHandle(raw));
        let worker_clone = Arc::clone(&holder);

        let mut code: u32 = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(worker_clone.raw(), &mut code) },
            0,
            "句柄在 Arc 持有期间必须有效"
        );

        // 模拟 async 任务被取消先释放主 Arc，阻塞线程仍持有 clone 期间句柄不得提前关闭。
        drop(holder);
        assert_ne!(
            unsafe { GetExitCodeProcess(worker_clone.raw(), &mut code) },
            0,
            "仍有阻塞线程 Arc 持有期间句柄必须保持有效"
        );

        // 最后一个持有者释放后 Drop 必须关闭内核句柄。
        drop(worker_clone);
        assert_eq!(unsafe { GetExitCodeProcess(raw, &mut code) }, 0);
        assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_HANDLE);
    }
}
