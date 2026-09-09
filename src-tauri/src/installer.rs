use crate::models::DownloadProgressPayload;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Emitter;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetKind {
    Msi,
    SetupExe,
    PortableZip,
    Deb,
    Rpm,
    AppImage,
    Dmg,
    Pkg,
    Apk,
    Other,
}

pub struct InstallerEngine;

impl InstallerEngine {
    pub fn select_best_asset(
        assets: &[crate::models::ReleaseAsset],
    ) -> Option<&crate::models::ReleaseAsset> {
        select_best_asset(assets)
    }

    pub fn resolve_uninstaller_command(
        app_name: &str,
        app_id: &str,
        install_path: &str,
        existing_command: Option<&str>,
    ) -> Option<String> {
        resolve_uninstaller_command(app_name, app_id, install_path, existing_command)
    }

    pub fn classify_asset(filename: &str) -> (AssetKind, &'static str, &'static str) {
        let name_lower = filename.to_lowercase();

        let arch = if name_lower.contains("arm64") || name_lower.contains("aarch64") {
            "aarch64"
        } else if name_lower.contains("x86_64")
            || name_lower.contains("x64")
            || name_lower.contains("amd64")
            || name_lower.contains("win64")
        {
            "x86_64"
        } else if name_lower.contains("x86")
            || name_lower.contains("i686")
            || name_lower.contains("i386")
            || name_lower.contains("win32")
            || name_lower.contains("ia32")
        {
            "x86"
        } else {
            "universal"
        };

        if name_lower.ends_with(".msi") {
            (AssetKind::Msi, "windows", arch)
        } else if name_lower.ends_with("-setup.exe")
            || name_lower.ends_with("_setup.exe")
            || name_lower.ends_with("-installer.exe")
            || name_lower.ends_with("_installer.exe")
            || name_lower.contains("install")
            || name_lower.ends_with(".exe")
        {
            (AssetKind::SetupExe, "windows", arch)
        } else if (name_lower.contains("portable")
            || name_lower.contains("win")
            || name_lower.contains("windows"))
            && (name_lower.ends_with(".zip") || name_lower.ends_with(".7z"))
        {
            (AssetKind::PortableZip, "windows", arch)
        } else if name_lower.ends_with(".deb") {
            (AssetKind::Deb, "linux", arch)
        } else if name_lower.ends_with(".rpm") {
            (AssetKind::Rpm, "linux", arch)
        } else if name_lower.ends_with(".appimage") {
            (AssetKind::AppImage, "linux", arch)
        } else if name_lower.ends_with(".dmg") {
            (AssetKind::Dmg, "macos", arch)
        } else if name_lower.ends_with(".pkg") {
            (AssetKind::Pkg, "macos", arch)
        } else if name_lower.ends_with(".apk") {
            (AssetKind::Apk, "android", "arm64-v8a")
        } else if name_lower.ends_with(".zip") || name_lower.ends_with(".7z") {
            let zip_os = if name_lower.contains("darwin")
                || name_lower.contains("macos")
                || name_lower.contains("osx")
                || name_lower.contains("mac")
            {
                "macos"
            } else if name_lower.contains("linux") {
                "linux"
            } else {
                "windows"
            };
            (AssetKind::PortableZip, zip_os, arch)
        } else if name_lower.ends_with(".tar.gz") || name_lower.ends_with(".tar.xz") {
            let tar_os = if name_lower.contains("darwin")
                || name_lower.contains("macos")
                || name_lower.contains("osx")
                || name_lower.contains("mac")
            {
                "macos"
            } else {
                "linux"
            };
            (AssetKind::Other, tar_os, arch)
        } else {
            (AssetKind::Other, "all", "universal")
        }
    }

    pub fn compute_sha256(path: &Path) -> Result<String, String> {
        let mut file = File::open(path).map_err(|e| format!("无法打开文件进行校验: {}", e))?;
        let mut hasher = Sha256::new();
        io::copy(&mut file, &mut hasher).map_err(|e| format!("计算哈希失败: {}", e))?;
        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    pub async fn download_with_progress(
        app_handle: &tauri::AppHandle,
        task_id: &str,
        download_url: &str,
        asset_name: &str,
        expected_sha256: Option<&str>,
        custom_download_dir: Option<&Path>,
    ) -> Result<(PathBuf, String), String> {
        let net_conf = &crate::config::get_project_config().network;
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Z-Store/0.1.0")
            .connect_timeout(std::time::Duration::from_secs(net_conf.connect_timeout_seconds))
            .tcp_keepalive(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(net_conf.download_timeout_seconds))
            .build()
            .map_err(|e| e.to_string())?;

        let resp_result = client.get(download_url).send().await;
        let resp = match resp_result {
            Ok(r) => {
                if !r.status().is_success() {
                    let err_msg = format!("下载请求失败，HTTP 状态码: {}", r.status());
                    let _ = app_handle.emit(
                        "zstore://download-progress",
                        DownloadProgressPayload {
                            task_id: task_id.to_string(),
                            downloaded_bytes: 0,
                            total_bytes: 0,
                            speed_bytes_per_sec: 0,
                            state: "error".to_string(),
                            message: Some(err_msg.clone()),
                        },
                    );
                    return Err(err_msg);
                }
                r
            }
            Err(e) => {
                let err_msg = format!("无法连接下载服务器: {}", e);
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    DownloadProgressPayload {
                        task_id: task_id.to_string(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        speed_bytes_per_sec: 0,
                        state: "error".to_string(),
                        message: Some(err_msg.clone()),
                    },
                );
                return Err(err_msg);
            }
        };

        let total_bytes = resp.content_length().unwrap_or(0);
        let temp_dir = if let Some(custom) = custom_download_dir {
            custom.to_path_buf()
        } else {
            default_download_dir()
        };
        let _ = std::fs::create_dir_all(&temp_dir);

        let safe_asset_name = Path::new(asset_name)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("package.bin");
        let safe_task_id: String = task_id
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let file_name = if safe_task_id.is_empty()
            || safe_asset_name
                .to_lowercase()
                .starts_with(&safe_task_id.to_lowercase())
        {
            safe_asset_name.to_string()
        } else {
            format!("{}_{}", safe_task_id, safe_asset_name)
        };
        let temp_path = temp_dir.join(file_name);

        let mut file = match File::create(&temp_path) {
            Ok(f) => f,
            Err(e) => {
                let err_msg = format!("创建临时文件失败: {}", e);
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    DownloadProgressPayload {
                        task_id: task_id.to_string(),
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        speed_bytes_per_sec: 0,
                        state: "error".to_string(),
                        message: Some(err_msg.clone()),
                    },
                );
                return Err(err_msg);
            }
        };

        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut hasher = Sha256::new();

        let mut last_emit = Instant::now();
        let mut last_bytes: u64 = 0;

        let chunk_timeout = std::time::Duration::from_secs(net_conf.chunk_timeout_seconds);
        loop {
            let chunk_opt = match tokio::time::timeout(chunk_timeout, stream.next()).await {
                Ok(Some(chunk_result)) => match chunk_result {
                    Ok(c) => Some(c),
                    Err(e) => {
                        let _ = std::fs::remove_file(&temp_path);
                        let err_msg = format!("下载数据流中断: {}", e);
                        let _ = app_handle.emit(
                            "zstore://download-progress",
                            DownloadProgressPayload {
                                task_id: task_id.to_string(),
                                downloaded_bytes: downloaded,
                                total_bytes,
                                speed_bytes_per_sec: 0,
                                state: "error".to_string(),
                                message: Some(err_msg.clone()),
                            },
                        );
                        return Err(err_msg);
                    }
                },
                Ok(None) => None,
                Err(_) => {
                    let _ = std::fs::remove_file(&temp_path);
                    let err_msg = "下载超时：超过 30 秒未接收到数据块，已中断连接".to_string();
                    let _ = app_handle.emit(
                        "zstore://download-progress",
                        DownloadProgressPayload {
                            task_id: task_id.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes,
                            speed_bytes_per_sec: 0,
                            state: "error".to_string(),
                            message: Some(err_msg.clone()),
                        },
                    );
                    return Err(err_msg);
                }
            };

            let chunk = match chunk_opt {
                Some(c) => c,
                None => break,
            };

            if let Err(e) = file.write_all(&chunk) {
                let _ = std::fs::remove_file(&temp_path);
                let err_msg = format!("写入磁盘失败: {}", e);
                let _ = app_handle.emit(
                    "zstore://download-progress",
                    DownloadProgressPayload {
                        task_id: task_id.to_string(),
                        downloaded_bytes: downloaded,
                        total_bytes,
                        speed_bytes_per_sec: 0,
                        state: "error".to_string(),
                        message: Some(err_msg.clone()),
                    },
                );
                return Err(err_msg);
            }
            hasher.update(&chunk);

            downloaded += chunk.len() as u64;

            if last_emit.elapsed().as_millis() >= 200 || (total_bytes > 0 && downloaded == total_bytes) {
                let elapsed_secs = last_emit.elapsed().as_secs_f64().max(0.001);
                let speed = ((downloaded - last_bytes) as f64 / elapsed_secs) as u64;

                let _ = app_handle.emit(
                    "zstore://download-progress",
                    DownloadProgressPayload {
                        task_id: task_id.to_string(),
                        downloaded_bytes: downloaded,
                        total_bytes,
                        speed_bytes_per_sec: speed,
                        state: "downloading".to_string(),
                        message: None,
                    },
                );

                last_emit = Instant::now();
                last_bytes = downloaded;
            }
        }

        let actual_hash = hex::encode(hasher.finalize());

        // 零信任哈希比对防篡改核心拦截
        let (verified_state, verified_msg) = if let Some(expected) = expected_sha256 {
            let exp_clean = expected.trim().to_lowercase();
            if !exp_clean.is_empty() {
                if actual_hash.to_lowercase() != exp_clean {
                    let _ = std::fs::remove_file(&temp_path);
                    let _ = app_handle.emit(
                        "zstore://download-progress",
                        DownloadProgressPayload {
                            task_id: task_id.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes: downloaded,
                            speed_bytes_per_sec: 0,
                            state: "tampered".to_string(),
                            message: Some(format!(
                                "哈希不符！期望: {}, 实际: {}",
                                exp_clean, actual_hash
                            )),
                        },
                    );
                    return Err(format!(
                        "安全拦截：SHA-256 完整性校验不符！官方校验值: {}，实际下载文件: {}。已阻止潜在篡改软件的安装执行。",
                        exp_clean, actual_hash
                    ));
                }
                (
                    "verified".to_string(),
                    format!("已通过官方 SHA-256 完整性校验: {}", actual_hash),
                )
            } else {
                (
                    "completed_unverified".to_string(),
                    format!("上游未提供官方校验清单，已记录本地计算 SHA-256: {}", actual_hash),
                )
            }
        } else {
            (
                "completed_unverified".to_string(),
                format!("上游未提供官方校验清单，已记录本地计算 SHA-256: {}", actual_hash),
            )
        };

        let _ = app_handle.emit(
            "zstore://download-progress",
            DownloadProgressPayload {
                task_id: task_id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: downloaded,
                speed_bytes_per_sec: 0,
                state: verified_state,
                message: Some(verified_msg),
            },
        );

        Ok((temp_path, actual_hash))
    }

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
                let app_dir = dirs_or_fallback_with_base(app_id, custom_portable_dir);
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
                    Self::create_desktop_shortcut(app_id, exe);
                }

                let _ = std::fs::remove_file(installer_path);
                Ok(format!("已解压至便携目录: {:?}", app_dir))
            }
            AssetKind::Dmg => {
                #[cfg(target_os = "macos")]
                {
                    let res = Self::install_macos_dmg(installer_path);
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
                    Ok("已拉起系统默认处理程序".to_string())
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn install_macos_dmg(installer_path: &Path) -> Result<String, String> {
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

    #[cfg(target_os = "windows")]
    pub fn create_desktop_shortcut(app_name: &str, exe_path: &Path) {
        // 清洗快捷方式文件名，过滤 Windows 非法文件名字符: \ / : * ? " < > |
        let clean_name: String = app_name
            .chars()
            .filter(|c| !['\\', '/', ':', '*', '?', '"', '<', '>', '|'].contains(c))
            .collect();
        let safe_name = clean_name.trim();
        let final_name = if safe_name.is_empty() { "App" } else { safe_name };

        let working_dir = exe_path.parent().unwrap_or(exe_path);
        let script = format!(
            "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\{}.lnk');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
            final_name.replace('\'', "''"),
            exe_path.to_string_lossy().replace('\'', "''"),
            working_dir.to_string_lossy().replace('\'', "''")
        );
        let _ = std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(&script)
            .output();
    }
}

/// 获取当前系统用户的主目录（跨平台：Windows: USERPROFILE / HOMEDRIVE+HOMEPATH；Unix: HOME）
pub fn user_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let p = PathBuf::from(profile);
            if p.exists() {
                return Some(p);
            }
        }
        if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            let p = PathBuf::from(format!("{}{}", drive, path));
            if p.exists() {
                return Some(p);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 默认下载安装包位置：统一为各操作系统的用户下载文件夹 `~/Downloads`
/// （Windows: %USERPROFILE%\Downloads；macOS/Linux: $HOME/Downloads）
pub fn default_download_dir() -> PathBuf {
    if let Some(home) = user_home_dir() {
        return home.join("Downloads");
    }
    std::env::temp_dir().join("Downloads")
}

pub fn expand_env_path(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed.is_empty() {
        return default_download_dir();
    }

    // 跨平台识别波浪号 ~ 前缀（~/Downloads 或 ~\Downloads 或 单独 ~）
    if trimmed == "~" {
        return user_home_dir().unwrap_or_else(default_download_dir);
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(home) = user_home_dir() {
            let sub_path: PathBuf = rest.split(['/', '\\']).collect();
            return home.join(sub_path);
        }
    }

    let mut expanded = trimmed.to_string();
    #[cfg(target_os = "windows")]
    {
        if expanded.contains('%') {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                expanded = expanded.replace("%LOCALAPPDATA%", &local_app_data);
            }
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                expanded = expanded.replace("%USERPROFILE%", &user_profile);
            }
            if let Ok(temp) = std::env::var("TEMP") {
                expanded = expanded.replace("%TEMP%", &temp);
            }
            if let Ok(appdata) = std::env::var("APPDATA") {
                expanded = expanded.replace("%APPDATA%", &appdata);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if expanded.starts_with("$HOME") {
            if let Ok(home) = std::env::var("HOME") {
                expanded = expanded.replacen("$HOME", &home, 1);
            }
        }
    }

    PathBuf::from(expanded)
}

pub fn dirs_or_fallback_with_base(app_id: &str, custom_base: Option<&str>) -> PathBuf {
    let safe_id: String = app_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let clean_id = if safe_id.is_empty() || safe_id.starts_with('.') {
        "app".to_string()
    } else {
        safe_id
    };

    if let Some(base) = custom_base {
        let trimmed = base.trim();
        if !trimmed.is_empty() {
            let expanded_base = expand_env_path(trimmed);
            return expanded_base.join(clean_id);
        }
    }

    dirs_or_fallback(app_id)
}

pub fn dirs_or_fallback(app_id: &str) -> PathBuf {
    // 消毒 app_id，防御路径逃逸
    let safe_id: String = app_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let clean_id = if safe_id.is_empty() || safe_id.starts_with('.') {
        "app".to_string()
    } else {
        safe_id
    };

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(app_data)
                .join("Programs")
                .join("z-store-apps")
                .join(clean_id);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Applications")
                .join("z-store-apps")
                .join(clean_id);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join("z-store-apps")
                .join(clean_id);
        }
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        PathBuf::from(home).join(".z-store-apps").join(clean_id)
    } else {
        std::env::temp_dir().join("z-store-apps").join(clean_id)
    }
}

/// 根据当前系统平台（Windows / macOS / Linux）与 CPU 架构（x86_64 / aarch64）智能择取最优安装包资产
pub fn select_best_asset(
    assets: &[crate::models::ReleaseAsset],
) -> Option<&crate::models::ReleaseAsset> {
    #[cfg(target_os = "windows")]
    let target_os = "windows";
    #[cfg(target_os = "macos")]
    let target_os = "macos";
    #[cfg(target_os = "linux")]
    let target_os = "linux";
    #[cfg(target_os = "android")]
    let target_os = "android";
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    let target_os = "all";

    #[cfg(target_arch = "x86_64")]
    let target_arch = "x86_64";
    #[cfg(target_arch = "aarch64")]
    let target_arch = "aarch64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let target_arch = "universal";

    let os_matches: Vec<&crate::models::ReleaseAsset> = assets
        .iter()
        .filter(|a| a.os == target_os || a.os == "all")
        .collect();

    let candidates = if os_matches.is_empty() {
        assets.iter().collect::<Vec<&crate::models::ReleaseAsset>>()
    } else {
        os_matches
    };

    candidates.into_iter().max_by_key(|a| {
        let mut score: i32 = 0;
        if a.os == target_os {
            score += 100;
        }
        if a.arch == target_arch {
            score += 50;
        } else if a.arch == "universal" {
            score += 25;
        } else if target_arch == "x86_64" && a.arch == "x86" {
            score += 10;
        } else {
            score -= 50;
        }

        #[cfg(target_os = "windows")]
        match a.kind.as_str() {
            "msi" => score += 20,
            "setup_exe" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "macos")]
        match a.kind.as_str() {
            "dmg" => score += 20,
            "pkg" => score += 15,
            "portable_zip" => score += 10,
            _ => {}
        }

        #[cfg(target_os = "linux")]
        match a.kind.as_str() {
            "appimage" => score += 20,
            "deb" => score += 15,
            "rpm" => score += 12,
            "portable_zip" => score += 10,
            _ => {}
        }

        score
    })
}

/// 自动嗅探或构造已安装应用的系统卸载命令行
pub fn resolve_uninstaller_command(
    app_name: &str,
    app_id: &str,
    install_path: &str,
    existing_command: Option<&str>,
) -> Option<String> {
    // 1. 如果已有明确且有效的卸载指令（非向导提示文案）
    if let Some(cmd) = existing_command {
        let trimmed = cmd.trim();
        if !trimmed.is_empty()
            && !trimmed.contains("已调起")
            && !trimmed.contains("跳过")
            && !trimmed.contains("非 Windows")
            && !trimmed.contains("已解压至")
        {
            return Some(trimmed.to_string());
        }
    }

    // 2. Windows 平台：动态查询注册表中的 UninstallString
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let targets = [
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ];

        let name_lower = app_name.to_lowercase();
        let id_lower = app_id.to_lowercase();
        let clean_id = id_lower.replace(['-', '_', '.'], "");

        for (hive, subpath) in targets {
            let root = RegKey::predef(hive);
            if let Ok(uninstall_key) = root.open_subkey(subpath) {
                for key_name in uninstall_key.enum_keys().map_while(Result::ok) {
                    if let Ok(app_key) = uninstall_key.open_subkey(&key_name) {
                        let display_name: String = app_key
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let disp_lower = display_name.to_lowercase();

                        let matched = !disp_lower.is_empty()
                            && (disp_lower == name_lower
                                || disp_lower == id_lower
                                || disp_lower.contains(&name_lower)
                                || name_lower.contains(&disp_lower)
                                || (!clean_id.is_empty()
                                    && disp_lower.replace(['-', '_', '.'], "").contains(&clean_id)));

                        if matched {
                            if let Ok(uninst) = app_key.get_value::<String, _>("UninstallString") {
                                let trimmed_uninst = uninst.trim().to_string();
                                if !trimmed_uninst.is_empty() {
                                    return Some(trimmed_uninst);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 3. 检查安装目录中的标准卸载程序
        let p = std::path::Path::new(install_path);
        let base_dir = if p.is_file() {
            p.parent()
        } else if p.is_dir() {
            Some(p)
        } else {
            None
        };

        if let Some(dir) = base_dir {
            let candidates = [
                "uninstall.exe",
                "Uninstall.exe",
                "unins000.exe",
                "unins001.exe",
                "uninst.exe",
            ];
            for c in candidates {
                let candidate_path = dir.join(c);
                if candidate_path.is_file() {
                    return Some(format!("\"{}\"", candidate_path.to_string_lossy()));
                }
            }
        }

        // 4. 检查开始菜单程序组中的卸载快捷方式
        let start_menu_candidates = [
            std::env::var("APPDATA")
                .ok()
                .map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs").join(app_name)),
            Some(
                std::path::PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs")
                    .join(app_name),
            ),
        ];

        for sdir_opt in start_menu_candidates.into_iter().flatten() {
            if sdir_opt.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&sdir_opt) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let fname = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                        if fname.contains("uninstall") && fname.ends_with(".lnk") {
                            return Some(format!("\"{}\"", path.to_string_lossy()));
                        }
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_classify_asset() {
        assert_eq!(
            InstallerEngine::classify_asset("vlc-3.0.21-win64.msi").0,
            AssetKind::Msi
        );
        assert_eq!(
            InstallerEngine::classify_asset("RustDesk-1.2.6-Setup.exe").0,
            AssetKind::SetupExe
        );
        assert_eq!(
            InstallerEngine::classify_asset("app-portable.zip").0,
            AssetKind::PortableZip
        );
        assert_eq!(
            InstallerEngine::classify_asset("obs-studio_30.1.2_amd64.deb").0,
            AssetKind::Deb
        );
        assert_eq!(
            InstallerEngine::classify_asset("LocalSend-1.15.2.AppImage").0,
            AssetKind::AppImage
        );
        assert_eq!(
            InstallerEngine::classify_asset("KeePassXC-2.7.9.dmg").0,
            AssetKind::Dmg
        );
        assert_eq!(
            InstallerEngine::classify_asset("Wireshark-4.2.4.pkg").0,
            AssetKind::Pkg
        );
        assert_eq!(
            InstallerEngine::classify_asset("rustdesk-1.2.6.rpm").0,
            AssetKind::Rpm
        );
    }

    #[test]
    fn test_build_unix_install_commands() {
        let test_path = Path::new("/tmp/test-installer.dmg");
        let cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Dmg, test_path);
        assert_eq!(cmds[0][0], "hdiutil");
        assert_eq!(cmds[0][1], "attach");

        let pkg_path = Path::new("/tmp/app.pkg");
        let pkg_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Pkg, pkg_path);
        assert_eq!(pkg_cmds[0][0], "installer");

        let appimage_path = Path::new("/home/user/app.AppImage");
        let ai_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::AppImage, appimage_path);
        assert_eq!(ai_cmds[0][0], "chmod");

        let deb_path = Path::new("/tmp/pkg.deb");
        let deb_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Deb, deb_path);
        assert_eq!(deb_cmds[0][0], "pkexec");
        assert_eq!(deb_cmds[0][1], "dpkg");

        let rpm_path = Path::new("/tmp/pkg.rpm");
        let rpm_cmds = InstallerEngine::build_unix_install_commands(&AssetKind::Rpm, rpm_path);
        assert_eq!(rpm_cmds[0][0], "pkexec");
        assert_eq!(rpm_cmds[0][1], "rpm");
    }

    #[test]
    fn test_hash_calculation() {
        let mut tmp = NamedTempFile::new().unwrap();
        write!(tmp, "hello z-store real download test").unwrap();
        tmp.flush().unwrap();

        let hash = InstallerEngine::compute_sha256(tmp.path()).unwrap();
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_expand_env_path_and_portable_dir() {
        let expanded = expand_env_path("C:\\Custom\\Path");
        assert_eq!(expanded, PathBuf::from("C:\\Custom\\Path"));

        let base = dirs_or_fallback_with_base("test-app", Some("D:\\PortableApps"));
        assert_eq!(base, PathBuf::from("D:\\PortableApps").join("test-app"));

        let base_default = dirs_or_fallback_with_base("test-app", None);
        assert!(base_default.to_string_lossy().contains("test-app"));

        // 测试跨平台 ~/Downloads 与默认下载目录
        let def_dl = default_download_dir();
        assert!(def_dl.to_string_lossy().ends_with("Downloads"));

        let tilde_dl = expand_env_path("~/Downloads");
        assert_eq!(tilde_dl, def_dl);

        let tilde_win_dl = expand_env_path("~\\Downloads");
        assert_eq!(tilde_win_dl, def_dl);

        let empty_dl = expand_env_path("");
        assert_eq!(empty_dl, def_dl);

        let whitespace_dl = expand_env_path("   ");
        assert_eq!(whitespace_dl, def_dl);
    }
}
