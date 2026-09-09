use crate::models::DownloadProgressPayload;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Emitter;

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
        super::paths::default_download_dir()
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
