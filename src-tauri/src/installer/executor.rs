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
