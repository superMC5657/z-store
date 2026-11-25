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

static MACOS_STAGE_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 在目标应用目录同级生成唯一暂存/备份 `.app` 路径，确保同卷原子 `rename`。
fn sibling_bundle_path(apps_dir: &Path, app_name: &std::ffi::OsStr, tag: &str) -> PathBuf {
    let nonce = MACOS_STAGE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    apps_dir.join(format!(
        ".{}.zstore-{}-{}-{}",
        app_name.to_string_lossy(),
        tag,
        std::process::id(),
        nonce
    ))
}

/// 原子替换目标 `.app`：已有旧版本时先改名为 `.bak`，再切入新暂存包；
/// 任一步失败立即恢复 `.bak`，避免升级中断删毁可用旧版本。
fn swap_staged_bundle_with<F>(
    staging_app: &Path,
    dest_app: &Path,
    apps_dir: &Path,
    app_name: &std::ffi::OsStr,
    mut rename_fn: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    if !dest_app.exists() {
        rename_fn(staging_app, dest_app)
            .map_err(|e| format!("提交应用至 {} 失败: {}", dest_app.display(), e))?;
        return Ok(());
    }

    let backup_app = sibling_bundle_path(apps_dir, app_name, "bak");
    rename_fn(dest_app, &backup_app).map_err(|e| {
        format!(
            "无法备份已存在的旧版本 {}（权限不足或应用正在运行）: {}。已中止安装，避免损坏旧版本",
            dest_app.display(),
            e
        )
    })?;

    if let Err(swap_err) = rename_fn(staging_app, dest_app) {
        return match rename_fn(&backup_app, dest_app) {
            Ok(()) => Err(format!(
                "替换新版本 {} 失败，已恢复旧版本: {}",
                dest_app.display(),
                swap_err
            )),
            Err(restore_err) => Err(format!(
                "替换新版本 {} 失败 ({})，且恢复旧版本失败 ({})；旧版本备份保留在 {}",
                dest_app.display(),
                swap_err,
                restore_err,
                backup_app.display()
            )),
        };
    }

    let _ = std::fs::remove_dir_all(&backup_app);
    Ok(())
}

/// 先将 `.app` 完整拷贝到同级暂存目录，再在阻塞线程池原子切入目标路径；
/// 拷贝或切换任一步失败均清理暂存目录且保留原有可用 `.app`。
async fn stage_and_swap_app_bundle<F, Fut>(
    src_app: &Path,
    apps_dir: &Path,
    app_name: &std::ffi::OsStr,
    copy_fn: F,
) -> Result<(), String>
where
    F: FnOnce(PathBuf, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let staging_app = sibling_bundle_path(apps_dir, app_name, "stage");
    let dest_app = apps_dir.join(app_name);

    if let Err(copy_err) = copy_fn(src_app.to_path_buf(), staging_app.clone()).await {
        let cleanup_path = staging_app.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if cleanup_path.exists() {
                let _ = std::fs::remove_dir_all(&cleanup_path);
            }
        })
        .await;
        return Err(copy_err);
    }

    let apps_dir_owned = apps_dir.to_path_buf();
    let app_name_owned = app_name.to_os_string();
    let staging_for_swap = staging_app.clone();
    let swap_res = tokio::task::spawn_blocking(move || {
        let res = swap_staged_bundle_with(
            &staging_for_swap,
            &dest_app,
            &apps_dir_owned,
            &app_name_owned,
            |from, to| std::fs::rename(from, to),
        );
        if res.is_err() && staging_for_swap.exists() {
            let _ = std::fs::remove_dir_all(&staging_for_swap);
        }
        res
    })
    .await
    .map_err(|e| format!("原子替换应用线程异常: {}", e))?;

    swap_res
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

    // 4. 先完整拷贝至 /Applications 同级暂存包，再原子切换（失败回滚 .bak 保留旧版本）
    let sys_apps = PathBuf::from("/Applications");
    let app_name_for_err = app_name.to_string_lossy().to_string();
    let install_res =
        stage_and_swap_app_bundle(&target_app, &sys_apps, &app_name, |src, dst| async move {
            let copy_argv = dmg_copy_argv(&src, &dst);
            let cp_status = super::run_argv(&copy_argv)
                .await
                .map_err(|e| format!("拷贝应用至 /Applications 失败: {}", e))?;
            if cp_status.success() {
                Ok(())
            } else {
                Err(format!(
                    "拷贝应用至 /Applications/{} 失败",
                    app_name_for_err
                ))
            }
        })
        .await;

    // 5. 卸载 DMG 释放挂载点
    mount.detach().await;

    install_res?;
    Ok(format!(
        "已成功解包并安装至 /Applications/{}",
        app_name.to_string_lossy()
    ))
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

    #[tokio::test]
    async fn dmg_upgrade_copy_failure_preserves_existing_v1_bundle() {
        let apps = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let src_app = src.path().join("MyApp.app");
        std::fs::create_dir_all(&src_app).unwrap();

        // 预先存在的 v1 应用包
        let dest_app = apps.path().join("MyApp.app");
        std::fs::create_dir_all(dest_app.join("Contents")).unwrap();
        std::fs::write(dest_app.join("Contents").join("version"), b"v1.0.0").unwrap();

        let err = super::stage_and_swap_app_bundle(
            &src_app,
            apps.path(),
            std::ffi::OsStr::new("MyApp.app"),
            |_src, dst| async move {
                // 模拟拷贝中途写入部分内容后失败（如磁盘满/镜像损坏）
                std::fs::create_dir_all(&dst).unwrap();
                std::fs::write(dst.join("partial"), b"half").unwrap();
                Err("cp failed: disk full".to_string())
            },
        )
        .await
        .expect_err("copy failure must abort upgrade");

        assert!(err.contains("disk full"), "{err}");
        assert_eq!(
            std::fs::read(dest_app.join("Contents").join("version")).unwrap(),
            b"v1.0.0",
            "existing v1 .app must remain completely intact when copy fails"
        );
        // 暂存目录必须已清理，不得残留
        let entries: Vec<_> = std::fs::read_dir(apps.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("MyApp.app")]);
    }

    #[tokio::test]
    async fn dmg_upgrade_success_atomically_replaces_v1_without_leftover_dirs() {
        let apps = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let src_app = src.path().join("MyApp.app");
        std::fs::create_dir_all(&src_app).unwrap();

        let dest_app = apps.path().join("MyApp.app");
        std::fs::create_dir_all(dest_app.join("Contents")).unwrap();
        std::fs::write(dest_app.join("Contents").join("version"), b"v1.0.0").unwrap();
        std::fs::write(dest_app.join("Contents").join("old_only"), b"old").unwrap();

        super::stage_and_swap_app_bundle(
            &src_app,
            apps.path(),
            std::ffi::OsStr::new("MyApp.app"),
            |_src, dst| async move {
                std::fs::create_dir_all(dst.join("Contents")).unwrap();
                std::fs::write(dst.join("Contents").join("version"), b"v2.0.0").unwrap();
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read(dest_app.join("Contents").join("version")).unwrap(),
            b"v2.0.0"
        );
        assert!(!dest_app.join("Contents").join("old_only").exists());
        let entries: Vec<_> = std::fs::read_dir(apps.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("MyApp.app")]);
    }

    #[test]
    fn dmg_swap_failure_restores_v1_from_backup() {
        let apps = tempfile::tempdir().unwrap();
        let dest_app = apps.path().join("MyApp.app");
        let staging_app = apps.path().join(".MyApp.app.zstore-stage-test");
        std::fs::create_dir_all(&dest_app).unwrap();
        std::fs::write(dest_app.join("version"), b"v1").unwrap();
        std::fs::create_dir_all(&staging_app).unwrap();
        std::fs::write(staging_app.join("version"), b"v2").unwrap();

        let mut step = 0usize;
        let err = super::swap_staged_bundle_with(
            &staging_app,
            &dest_app,
            apps.path(),
            std::ffi::OsStr::new("MyApp.app"),
            |from, to| {
                step += 1;
                if step == 2 {
                    // 第 1 步 dest -> bak 成功，第 2 步 staging -> dest 注入失败，第 3 步 bak -> dest 恢复
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected swap failure",
                    ));
                }
                std::fs::rename(from, to)
            },
        )
        .expect_err("injected swap error must fail");

        assert!(err.contains("已恢复旧版本"), "{err}");
        assert_eq!(std::fs::read(dest_app.join("version")).unwrap(), b"v1");
    }
}
