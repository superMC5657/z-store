#![cfg(any(target_os = "macos", test))]

#[cfg(target_os = "macos")]
use super::InstallOutcome;
use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;

/// macOS PKG 拉起 argv 纯函数（真实实现为 `open -W`）。
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

/// 挂载卷内的 `.app` 包探测：以 `symlink_metadata` 判定真实目录，
/// 符号链接（可指向卷外任意目录）一律不认作应用包。
pub fn find_app_bundle(volume: &Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(volume).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("app") {
            continue;
        }
        let is_real_dir = std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false);
        if is_real_dir {
            return Some(path);
        }
    }
    None
}

/// DMG 挂载点守卫：`hdiutil attach` 成功后持有卷路径。正常流程经 [`DmgMountGuard::detach`]
/// 异步卸载；任何提前返回或 Future 被取消时由 `Drop` 在独立线程尽力 `hdiutil detach`，
/// 不阻塞 async worker，也不残留挂载点。
#[cfg(any(target_os = "macos", test))]
struct DmgMountGuard {
    volume: Option<PathBuf>,
    #[cfg(test)]
    on_detach: Option<std::sync::Arc<dyn Fn(Vec<String>) + Send + Sync>>,
}

#[cfg(any(target_os = "macos", test))]
impl DmgMountGuard {
    #[cfg(target_os = "macos")]
    fn new(volume: PathBuf) -> Self {
        Self {
            volume: Some(volume),
            #[cfg(test)]
            on_detach: None,
        }
    }

    #[cfg(test)]
    fn with_detach_hook(
        volume: PathBuf,
        on_detach: std::sync::Arc<dyn Fn(Vec<String>) + Send + Sync>,
    ) -> Self {
        Self {
            volume: Some(volume),
            on_detach: Some(on_detach),
        }
    }

    #[cfg(target_os = "macos")]
    fn volume(&self) -> &Path {
        self.volume.as_deref().unwrap_or_else(|| Path::new(""))
    }

    async fn detach(mut self) {
        if let Some(volume) = self.volume.take() {
            let argv = dmg_detach_argv(&volume);
            #[cfg(test)]
            if let Some(cb) = self.on_detach.take() {
                cb(argv);
                #[cfg(target_os = "macos")]
                return;
            }
            #[cfg(target_os = "macos")]
            let _ = super::run_argv(&argv).await;
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl Drop for DmgMountGuard {
    fn drop(&mut self) {
        let Some(volume) = self.volume.take() else {
            return;
        };
        let argv = dmg_detach_argv(&volume);
        #[cfg(test)]
        if let Some(cb) = self.on_detach.take() {
            cb(argv);
            #[cfg(target_os = "macos")]
            return;
        }
        #[cfg(target_os = "macos")]
        let _ = std::thread::Builder::new()
            .name("dmg-detach".to_string())
            .spawn(move || {
                if let Some((prog, args)) = argv.split_first() {
                    let _ = std::process::Command::new(prog).args(args).status();
                }
            });
    }
}

/// macOS DMG 安装体。
#[cfg(target_os = "macos")]
pub async fn install_dmg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let res = install_macos_dmg(installer_path).await;
    res.map(InstallOutcome::Installed)
}

/// macOS PKG 安装体。
#[cfg(target_os = "macos")]
pub async fn install_pkg(installer_path: &Path) -> Result<InstallOutcome, String> {
    let argv = pkg_open_argv(installer_path);
    let status = super::run_argv(&argv)
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
pub async fn install_macos_dmg(installer_path: &Path) -> Result<String, String> {
    // 1. 命令行 hdiutil attach -nobrowse -readonly 挂载镜像
    // attach 需解析 stdout（output），走同一空 argv 守卫后直调 tokio output；
    // 其余 detach/cp -R 状态执行统一走 super::run_argv。
    let attach_argv = dmg_attach_argv(installer_path);
    let (attach_prog, attach_args) = attach_argv
        .split_first()
        .ok_or_else(|| "空 argv：拒绝执行".to_string())?;
    let attach_output = tokio::process::Command::new(attach_prog)
        .args(attach_args)
        .output()
        .await
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

    let Some(volume_path) = mount_point else {
        return Err("无法从 hdiutil 输出中探测到挂载卷路径".to_string());
    };
    let mount = DmgMountGuard::new(volume_path);

    // 3. 探测挂载卷内的 .app 目录
    let Some(target_app) = find_app_bundle(mount.volume()) else {
        mount.detach().await;
        return Err("DMG 挂载卷内未发现有效 .app 应用程序包".to_string());
    };

    let app_name = target_app
        .file_name()
        .ok_or_else(|| "无法获取 .app 目录名称".to_string())?
        .to_os_string();

    // 4. 拷贝至 /Applications 或用户 ~/Applications 目录
    // 旧版本删除失败必须中止：吞错继续 cp -R 会在已存在目录下生成
    // `X.app/X.app` 嵌套坏安装（应用无法启动且残留难以清理）。
    let sys_apps = PathBuf::from("/Applications");
    let dest_app = sys_apps.join(&app_name);

    if dest_app.exists() {
        std::fs::remove_dir_all(&dest_app).map_err(|e| {
            format!(
                "无法移除已存在的旧版本 {}（权限不足或文件被占用）: {}。已中止安装，避免嵌套坏安装",
                dest_app.display(),
                e
            )
        })?;
        if dest_app.exists() {
            return Err(format!(
                "旧版本 {} 移除指令执行后仍存在，已中止安装避免嵌套复制",
                dest_app.display()
            ));
        }
    }

    let copy_argv = dmg_copy_argv(&target_app, &dest_app);
    let cp_status = super::run_argv(&copy_argv)
        .await
        .map_err(|e| format!("拷贝应用至 /Applications 失败: {}", e))?;

    // 5. 卸载 DMG 释放挂载点
    mount.detach().await;

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

#[cfg(test)]
mod app_bundle_tests {
    use super::find_app_bundle;

    #[test]
    fn finds_real_app_directory_and_ignores_plain_files() {
        let vol = tempfile::tempdir().unwrap();
        std::fs::write(vol.path().join("Fake.app"), b"not a dir").unwrap();
        assert_eq!(find_app_bundle(vol.path()), None);
        std::fs::create_dir(vol.path().join("Real.app")).unwrap();
        assert_eq!(
            find_app_bundle(vol.path()),
            Some(vol.path().join("Real.app"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_app_bundle_is_rejected() {
        let vol = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), vol.path().join("Evil.app")).unwrap();
        assert_eq!(find_app_bundle(vol.path()), None);
    }

    #[test]
    fn dmg_mount_guard_detaches_on_early_drop_with_expected_argv() {
        use std::sync::{Arc, Mutex};
        let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        {
            let _guard = super::DmgMountGuard::with_detach_hook(
                std::path::PathBuf::from("/Volumes/TestApp"),
                Arc::new(move |argv| recorded.lock().unwrap().push(argv)),
            );
            // 模拟挂载后提前 `?` 返回或 Future 被取消，未显式调用 `.detach()`。
        }
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            vec!["hdiutil", "detach", "/Volumes/TestApp", "-force"]
        );
    }

    #[tokio::test]
    async fn dmg_mount_guard_detach_disarms_drop_without_double_detach() {
        use std::sync::{Arc, Mutex};
        let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        let guard = super::DmgMountGuard::with_detach_hook(
            std::path::PathBuf::from("/Volumes/TestApp"),
            Arc::new(move |argv| recorded.lock().unwrap().push(argv)),
        );
        guard.detach().await;
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "显式 detach 后 Drop 不得重复卸载");
    }
}
