use super::InstallOutcome;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// 便携 ZIP 解压安装体（原 executor.rs PortableZip 分支纯移动，跨平台）。
pub fn install_portable_zip(
    installer_path: &Path,
    app_id: &str,
    custom_portable_dir: Option<&str>,
) -> Result<InstallOutcome, String> {
    let app_dir = crate::installer::paths::dirs_or_fallback_with_base(app_id, custom_portable_dir);
    let _ = std::fs::create_dir_all(&app_dir);

    let file = File::open(installer_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "打开 ZIP 归档失败 (文件: {}): {}。仅支持 .zip 格式，不支持 .7z",
            installer_path.display(),
            e
        )
    })?;

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

            if outpath.extension().and_then(|ext| ext.to_str()) == Some("exe") && main_exe.is_none()
            {
                main_exe = Some(outpath);
            }
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(ref exe) = main_exe {
        crate::installer::paths::create_desktop_shortcut(app_id, exe);
    }

    Ok(InstallOutcome::Installed(format!(
        "已解压至便携目录: {:?}",
        app_dir
    )))
}
