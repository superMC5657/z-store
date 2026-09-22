#[cfg(target_os = "macos")]
use super::InstallOutcome;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

/// macOS DMG 安装体（原 executor.rs 内联 cfg(macos) 分支纯移动）。
#[cfg(target_os = "macos")]
pub async fn install_dmg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let res = install_macos_dmg(installer_path);
    res.map(InstallOutcome::Installed)
}

/// macOS PKG 安装体（原 executor.rs 内联 cfg(macos) 分支纯移动）。
#[cfg(target_os = "macos")]
pub async fn install_pkg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let status = tokio::process::Command::new("open")
        .arg("-W")
        .arg(installer_path)
        .status()
        .await
        .map_err(|e| format!("拉起 macOS PKG 安装器失败: {}", e))?;

    if status.success() {
        Ok(InstallOutcome::Installed("macOS PKG 安装已完成".to_string()))
    } else {
        Err("macOS PKG 安装向导未完成或被取消".to_string())
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
