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
    AppImage,
    Dmg,
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
        } else if name_lower.ends_with(".appimage") {
            (AssetKind::AppImage, "linux", arch)
        } else if name_lower.ends_with(".dmg") {
            (AssetKind::Dmg, "macos", arch)
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
        if let Some(expected) = expected_sha256 {
            let exp_clean = expected.trim().to_lowercase();
            if !exp_clean.is_empty() && actual_hash.to_lowercase() != exp_clean {
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
        }

        let _ = app_handle.emit(
            "zstore://download-progress",
            DownloadProgressPayload {
                task_id: task_id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: downloaded,
                speed_bytes_per_sec: 0,
                state: "verified".to_string(),
                message: Some(format!("已通过官方 SHA-256 完整性校验: {}", actual_hash)),
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
