use super::AssetKind;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

pub async fn execute_installation(
    installer_path: &Path,
    kind: &AssetKind,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<String, String> {
    match kind {
        AssetKind::Msi => {
            #[cfg(target_os = "windows")]
            {
                use std::time::Duration;
                // FR-3.5 静默优先：首先尝试 `msiexec /i <pkg> /qn /norestart` 全静默安装
                let silent_status = tokio::process::Command::new("msiexec.exe")
                    .arg("/i")
                    .arg(installer_path)
                    .arg("/qn")
                    .arg("/norestart")
                    .status()
                    .await
                    .map_err(|e| format!("调起 MSI 静默安装器失败: {}", e))?;

                if silent_status.success() {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    let _ = std::fs::remove_file(installer_path);
                    return Ok("MSI 静默安装已完成".to_string());
                }

                let code = silent_status.code().unwrap_or(-1);
                if code == 1602 {
                    let _ = std::fs::remove_file(installer_path);
                    return Err("用户取消了 MSI 安装向导".to_string());
                }

                // 静默被拒绝或非零退出：降级拉起原生 GUI 向导，并等待用户在向导中完成或取消
                let mut fallback = tokio::process::Command::new("msiexec.exe")
                    .arg("/i")
                    .arg(installer_path)
                    .spawn()
                    .map_err(|e| {
                        format!("静默安装被拒绝且拉起 MSI 向导失败: {}", e)
                    })?;

                let fallback_status = fallback
                    .wait()
                    .await
                    .map_err(|e| format!("MSI 向导进程异常: {}", e))?;

                let _ = std::fs::remove_file(installer_path);

                if fallback_status.success() {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    Ok("MSI 安装已完成".to_string())
                } else {
                    let fb_code = fallback_status.code().unwrap_or(-1);
                    if fb_code == 1602 {
                        Err("用户取消了 MSI 安装向导".to_string())
                    } else {
                        Err(format!("MSI 安装未能成功完成 (退出代码: {})", fb_code))
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(format!("当前平台跳过 MSI 安装: {:?}", installer_path))
            }
        }
        AssetKind::SetupExe => {
            #[cfg(target_os = "windows")]
            {
                use std::time::Duration;
                let mut child = tokio::process::Command::new(installer_path)
                    .spawn()
                    .map_err(|e| format!("调起安装程序失败: {}", e))?;

                let status = child
                    .wait()
                    .await
                    .map_err(|e| format!("安装程序运行异常: {}", e))?;

                tokio::time::sleep(Duration::from_millis(800)).await;
                let _ = std::fs::remove_file(installer_path);

                if status.success() {
                    Ok("安装程序已完成".to_string())
                } else {
                    let code = status.code().unwrap_or(-1);
                    if code == 1602 || code == 1 || code == 2 {
                        Err(format!("用户取消了安装向导或安装已中止 (退出代码: {})", code))
                    } else {
                        Err(format!("安装程序未能成功完成 (退出代码: {})", code))
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(format!("非 Windows 平台: {:?}", installer_path))
            }
        }
        AssetKind::PortableZip => {
            let app_dir = super::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
            let _ = std::fs::create_dir_all(&app_dir);

            let file = File::open(installer_path).map_err(|e| e.to_string())?;
            let mut archive =
                zip::ZipArchive::new(file).map_err(|e| format!("打开 ZIP 归档失败: {}", e))?;

            let mut main_exe: Option<PathBuf> = None;
            for i in 0..archive.len() {
                let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
                let outpath = match file.enclosed_name() {
                    Some(path) => app_dir.join(path),
                    None => continue,
                };

                if file.name().ends_with('/') {
                    let _ = std::fs::create_dir_all(&outpath);
                } else {
                    if let Some(p) = outpath.parent() {
                        if !p.exists() {
                            let _ = std::fs::create_dir_all(p);
                        }
                    }
                    let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
                    io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;

                    if outpath.extension().and_then(|ext| ext.to_str()) == Some("exe")
                        && main_exe.is_none()
                    {
                        main_exe = Some(outpath);
                    }
                }
            }

            #[cfg(target_os = "windows")]
            if let Some(ref exe) = main_exe {
                super::paths::create_desktop_shortcut(app_id, exe);
            }

            let _ = std::fs::remove_file(installer_path);
            Ok(format!("已解压至便携目录: {:?}", app_dir))
        }
        AssetKind::Dmg => {
            #[cfg(target_os = "macos")]
            {
                let res = install_macos_dmg(installer_path);
                let _ = std::fs::remove_file(installer_path);
                res
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(format!("非 macOS 平台跳过 DMG 挂载与解构安装: {:?}", installer_path))
            }
        }
        AssetKind::Pkg => {
            #[cfg(target_os = "macos")]
            {
                let status = tokio::process::Command::new("open")
                    .arg("-W")
                    .arg(installer_path)
                    .status()
                    .await
                    .map_err(|e| format!("拉起 macOS PKG 安装器失败: {}", e))?;

                let _ = std::fs::remove_file(installer_path);
                if status.success() {
                    Ok("macOS PKG 安装已完成".to_string())
                } else {
                    Err("macOS PKG 安装向导未完成或被取消".to_string())
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(format!("非 macOS 平台跳过 PKG 安装: {:?}", installer_path))
            }
        }
        AssetKind::AppImage => {
            #[cfg(target_os = "linux")]
            {
                let _ = tokio::process::Command::new("chmod")
                    .arg("+x")
                    .arg(installer_path)
                    .status()
                    .await;
                let status = tokio::process::Command::new(installer_path)
                    .status()
                    .await
                    .map_err(|e| format!("启动 AppImage 失败: {}", e))?;
                if status.success() {
                    Ok("已赋予可执行权限并启动 AppImage".to_string())
                } else {
                    Err("AppImage 执行未正常退出".to_string())
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(format!("非 Linux 平台跳过 AppImage 执行: {:?}", installer_path))
            }
        }
        AssetKind::Deb => {
            #[cfg(target_os = "linux")]
            {
                let status = tokio::process::Command::new("pkexec")
                    .arg("dpkg")
                    .arg("-i")
                    .arg(installer_path)
                    .status()
                    .await
                    .map_err(|e| format!("调起 pkexec dpkg 失败: {}", e))?;
                let _ = std::fs::remove_file(installer_path);
                if status.success() {
                    Ok("deb 包安装已完成".to_string())
                } else {
                    Err("deb 包提权安装未完成或被取消".to_string())
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(format!("非 Linux 平台跳过 deb 安装: {:?}", installer_path))
            }
        }
        AssetKind::Rpm => {
            #[cfg(target_os = "linux")]
            {
                let status = tokio::process::Command::new("pkexec")
                    .arg("rpm")
                    .arg("-i")
                    .arg(installer_path)
                    .status()
                    .await
                    .map_err(|e| format!("调起 pkexec rpm 失败: {}", e))?;
                let _ = std::fs::remove_file(installer_path);
                if status.success() {
                    Ok("rpm 包安装已完成".to_string())
                } else {
                    Err("rpm 包提权安装未完成或被取消".to_string())
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(format!("非 Linux 平台跳过 rpm 安装: {:?}", installer_path))
            }
        }
        _ => {
            #[cfg(target_os = "windows")]
            {
                let status = tokio::process::Command::new("cmd.exe")
                    .arg("/c")
                    .arg("start")
                    .arg("/wait")
                    .arg(installer_path)
                    .status()
                    .await
                    .map_err(|e| format!("调起系统默认程序失败: {}", e))?;
                let _ = std::fs::remove_file(installer_path);
                if status.success() {
                    Ok("系统默认程序已处理完成".to_string())
                } else {
                    Err("处理未正常完成".to_string())
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(format!("已拉起系统默认处理程序: {:?}", installer_path))
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn install_macos_dmg(installer_path: &Path) -> Result<String, String> {
    // 1. 命令行 hdiutil attach -nobrowse -readonly 挂载镜像
    let attach_output = std::process::Command::new("hdiutil")
        .arg("attach")
        .arg("-nobrowse")
        .arg("-readonly")
        .arg(installer_path)
        .output()
        .map_err(|e| format!("挂载 DMG 镜像失败: {}", e))?;

    if !attach_output.status.success() {
        let err = String::from_utf8_lossy(&attach_output.stderr);
        return Err(format!("挂载 DMG 镜像失败: {}", err));
    }

    // 2. 探测挂载卷路径 (/Volumes/...)
    let stdout_str = String::from_utf8_lossy(&attach_output.stdout);
    let mount_point = stdout_str
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            parts.last().map(|p| p.trim())
        })
        .find(|p| p.starts_with("/Volumes/"))
        .map(PathBuf::from);

    let volume_path = match mount_point {
        Some(p) => p,
        None => {
            return Err("无法从 hdiutil 输出中探测到挂载卷路径".to_string());
        }
    };

    // 3. 探测挂载卷内的 .app 目录
    let app_in_volume = std::fs::read_dir(&volume_path)
        .ok()
        .and_then(|entries| {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.extension().and_then(|e| e.to_str()) == Some("app") {
                    return Some(path);
                }
            }
            None
        });

    let target_app = match app_in_volume {
        Some(p) => p,
        None => {
            let _ = std::process::Command::new("hdiutil")
                .arg("detach")
                .arg(&volume_path)
                .arg("-force")
                .status();
            return Err("DMG 挂载卷内未发现有效 .app 应用程序包".to_string());
        }
    };

    let app_name = target_app
        .file_name()
        .ok_or_else(|| "无法获取 .app 目录名称".to_string())?;

    // 4. 拷贝至 /Applications 或用户 ~/Applications 目录
    let sys_apps = PathBuf::from("/Applications");
    let dest_app = sys_apps.join(app_name);

    if dest_app.exists() {
        let _ = std::fs::remove_dir_all(&dest_app);
    }

    let cp_status = std::process::Command::new("cp")
        .arg("-R")
        .arg(&target_app)
        .arg(&dest_app)
        .status()
        .map_err(|e| format!("拷贝应用至 /Applications 失败: {}", e))?;

    // 5. 卸载 DMG 释放挂载点
    let _ = std::process::Command::new("hdiutil")
        .arg("detach")
        .arg(&volume_path)
        .arg("-force")
        .status();

    if cp_status.success() {
        Ok(format!("已成功解包并安装至 /Applications/{}", app_name.to_string_lossy()))
    } else {
        Err(format!("拷贝应用至 /Applications/{} 失败", app_name.to_string_lossy()))
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

/// 智能拆分 Windows 卸载命令行为 (可执行文件路径, 参数列表)
pub fn parse_uninstaller_command(cmd: &str) -> (String, Vec<String>) {
    let trimmed = cmd.trim();
    if trimmed.starts_with('"') {
        if let Some(end_idx) = trimmed[1..].find('"') {
            let exe = trimmed[1..=end_idx].to_string();
            let args_part = trimmed[end_idx + 2..].trim();
            let args = if args_part.is_empty() {
                Vec::new()
            } else {
                args_part.split_whitespace().map(|s| s.to_string()).collect()
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
                if p.is_file() && p.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("exe")) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn is_file_locked(path: &std::path::Path) -> bool {
    match std::fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => false,
        Err(e) => {
            e.raw_os_error() == Some(32) || e.kind() == std::io::ErrorKind::PermissionDenied
        }
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
                                    if ext.eq_ignore_ascii_case("exe") {
                                        if is_file_locked(&sub_p) {
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
    }
    None
}

/// 执行官方卸载向导并异步挂起等待用户操作完成，随后核验卸载状态
pub async fn execute_uninstallation(
    uninstaller_cmd: &str,
    main_install_path: &str,
    app_name: &str,
) -> Result<(), String> {
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
            child.wait().await.map_err(|e| format!("快捷方式执行异常: {}", e))?
        } else {
            let is_nsis = is_nsis_uninstaller(&exe);
            let mut std_cmd = std::process::Command::new(&exe);
            std_cmd.args(&args);

            let mut cmd = tokio::process::Command::from(std_cmd);
            let mut child = cmd.spawn().map_err(|e| {
                format!("无法调起 {} 的官方卸载程序 ({}): {}", app_name, exe, e)
            })?;
            let exit_status = child.wait().await.map_err(|e| format!("卸载向导运行异常: {}", e))?;

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
            return Err(format!(
                "卸载向导异常退出或被用户取消 (退出代码: {})",
                code
            ));
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", uninstaller_cmd])
            .spawn()
            .map_err(|e| format!("执行卸载脚本失败: {}", e))?;
        let status = child.wait().await.map_err(|e| format!("卸载进程异常: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("卸载未能成功完成 (退出代码: {:?})", status.code()))
        }
    }
}

