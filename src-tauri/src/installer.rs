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
        } else if name_lower.ends_with(".zip") {
            (AssetKind::PortableZip, "windows", arch)
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
    ) -> Result<(PathBuf, String), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("请求下载地址失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("下载服务返回错误状态: {}", resp.status()));
        }

        let total_bytes = resp.content_length().unwrap_or(0);
        let temp_dir = std::env::temp_dir().join("zstore_downloads");
        let _ = std::fs::create_dir_all(&temp_dir);
        let temp_path = temp_dir.join(format!("{}_{}", task_id, asset_name));

        let mut file = File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {}", e))?;

        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut hasher = Sha256::new();

        let mut last_emit = Instant::now();
        let mut last_bytes: u64 = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("下载中断: {}", e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("写入磁盘失败: {}", e))?;
            hasher.update(&chunk);

            downloaded += chunk.len() as u64;

            if last_emit.elapsed().as_millis() >= 200 || downloaded == total_bytes {
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

    pub fn execute_installation(
        installer_path: &Path,
        kind: &AssetKind,
        app_id: &str,
    ) -> Result<String, String> {
        match kind {
            AssetKind::Msi => {
                #[cfg(target_os = "windows")]
                {
                    let status = std::process::Command::new("msiexec.exe")
                        .arg("/i")
                        .arg(installer_path)
                        .arg("/qn")
                        .status()
                        .map_err(|e| format!("启动 MSI 安装器失败: {}", e))?;

                    if status.success() {
                        Ok("MSI 静默安装已完成".to_string())
                    } else {
                        let _ = std::process::Command::new("msiexec.exe")
                            .arg("/i")
                            .arg(installer_path)
                            .spawn();
                        Ok("已调起安装向导".to_string())
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
                    let child = std::process::Command::new(installer_path).arg("/S").spawn();

                    match child {
                        Ok(_) => Ok("已调起静默安装".to_string()),
                        Err(_) => {
                            let _ = std::process::Command::new(installer_path).spawn();
                            Ok("已调起安装向导".to_string())
                        }
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    Ok(format!("非 Windows 平台: {:?}", installer_path))
                }
            }
            AssetKind::PortableZip => {
                let app_dir = dirs_or_fallback(app_id);
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

                Ok(format!("已解压至便携目录: {:?}", app_dir))
            }
            AssetKind::Dmg => {
                #[cfg(target_os = "macos")]
                {
                    Self::install_macos_dmg(installer_path)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Ok(format!("非 macOS 平台跳过 DMG 挂载与解构安装: {:?}", installer_path))
                }
            }
            AssetKind::Pkg => {
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("open")
                        .arg(installer_path)
                        .spawn();
                    Ok("已拉起 macOS PKG 系统安装向导".to_string())
                }
                #[cfg(not(target_os = "macos"))]
                {
                    Ok(format!("非 macOS 平台跳过 PKG 安装: {:?}", installer_path))
                }
            }
            AssetKind::AppImage => {
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("chmod")
                        .arg("+x")
                        .arg(installer_path)
                        .status();
                    let _ = std::process::Command::new(installer_path).spawn();
                    Ok("已赋予可执行权限并启动 AppImage".to_string())
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Ok(format!("非 Linux 平台跳过 AppImage 执行: {:?}", installer_path))
                }
            }
            AssetKind::Deb => {
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("pkexec")
                        .arg("dpkg")
                        .arg("-i")
                        .arg(installer_path)
                        .spawn();
                    Ok("已调起 pkexec dpkg 提权安装 deb 包".to_string())
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Ok(format!("非 Linux 平台跳过 deb 安装: {:?}", installer_path))
                }
            }
            AssetKind::Rpm => {
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("pkexec")
                        .arg("rpm")
                        .arg("-i")
                        .arg(installer_path)
                        .spawn();
                    Ok("已调起 pkexec rpm 提权安装 rpm 包".to_string())
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Ok(format!("非 Linux 平台跳过 rpm 安装: {:?}", installer_path))
                }
            }
            _ => {
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("explorer.exe")
                        .arg(installer_path)
                        .spawn();
                }
                Ok("已拉起系统默认处理程序".to_string())
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
        let working_dir = exe_path.parent().unwrap_or(exe_path);
        let script = format!(
            "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\{}.lnk');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
            app_name,
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

pub fn dirs_or_fallback(app_id: &str) -> PathBuf {
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(app_data)
            .join("Programs")
            .join("z-store-apps")
            .join(app_id)
    } else {
        std::env::temp_dir().join("z-store-apps").join(app_id)
    }
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
}
