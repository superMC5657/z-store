#[cfg(target_os = "macos")]
use super::InstallOutcome;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

/// macOS PKG 拉起 argv 纯函数（真实实现为 `open -W`，旧桩 `installer -pkg` 已删）。
pub fn pkg_open_argv(path: &Path) -> Vec<String> {
    vec![
        "open".to_string(),
        "-W".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

/// DMG 挂载 argv 纯函数。
pub fn dmg_attach_argv(path: &Path) -> Vec<String> {
    vec![
        "hdiutil".to_string(),
        "attach".to_string(),
        "-nobrowse".to_string(),
        "-readonly".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

/// DMG 卸载 argv 纯函数。
pub fn dmg_detach_argv(volume: &Path) -> Vec<String> {
    vec![
        "hdiutil".to_string(),
        "detach".to_string(),
        volume.to_string_lossy().to_string(),
        "-force".to_string(),
    ]
}

/// DMG 拷贝 argv 纯函数（`cp -R <src_app> <dst_app>`）。
pub fn dmg_copy_argv(src_app: &Path, dst_app: &Path) -> Vec<String> {
    vec![
        "cp".to_string(),
        "-R".to_string(),
        src_app.to_string_lossy().to_string(),
        dst_app.to_string_lossy().to_string(),
    ]
}

/// macOS DMG 安装体（原 executor.rs 内联 cfg(macos) 分支纯移动）。
#[cfg(target_os = "macos")]
pub async fn install_dmg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let res = install_macos_dmg(installer_path);
    res.map(InstallOutcome::Installed)
}

/// macOS PKG 安装体（原 executor.rs 内联 cfg(macos) 分支纯移动）。
#[cfg(target_os = "macos")]
pub async fn install_pkg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = pkg_open_argv(installer_path);
    let status = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .await
        .map_err(|e| format!("拉起 macOS PKG 安装器失败: {}", e))?;

    if status.success() {
        Ok(InstallOutcome::Installed(
            "macOS PKG 安装已完成".to_string(),
        ))
    } else {
        Err("macOS PKG 安装向导未完成或被取消".to_string())
    }
}

#[cfg(target_os = "macos")]
pub fn install_macos_dmg(installer_path: &Path) -> Result<String, String> {
    // 1. 命令行 hdiutil attach -nobrowse -readonly 挂载镜像
    let attach_argv = dmg_attach_argv(installer_path);
    let attach_output = std::process::Command::new(&attach_argv[0])
        .args(&attach_argv[1..])
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
    let app_in_volume = std::fs::read_dir(&volume_path).ok().and_then(|entries| {
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
            let detach_argv = dmg_detach_argv(&volume_path);
            let _ = std::process::Command::new(&detach_argv[0])
                .args(&detach_argv[1..])
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

    let copy_argv = dmg_copy_argv(&target_app, &dest_app);
    let cp_status = std::process::Command::new(&copy_argv[0])
        .args(&copy_argv[1..])
        .status()
        .map_err(|e| format!("拷贝应用至 /Applications 失败: {}", e))?;

    // 5. 卸载 DMG 释放挂载点
    let detach_argv = dmg_detach_argv(&volume_path);
    let _ = std::process::Command::new(&detach_argv[0])
        .args(&detach_argv[1..])
        .status();

    if cp_status.success() {
        Ok(format!(
            "已成功解包并安装至 /Applications/{}",
            app_name.to_string_lossy()
        ))
    } else {
        Err(format!(
            "拷贝应用至 /Applications/{} 失败",
            app_name.to_string_lossy()
        ))
    }
}
