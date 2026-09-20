use crate::log_support::{file_base, http_err_reason, sanitize_url, short_reason};
use crate::models::DownloadProgressPayload;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io;
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

/// 异步落盘关键路径（P1-10a）的执行结果。
/// 携带调用方重现历史日志与发送 `zstore://download-progress` 事件所需的全部上下文。
#[derive(Debug)]
enum PersistError<E> {
    Create(std::io::Error),
    Stream { downloaded: u64, source: E },
    Timeout { downloaded: u64 },
    Write { downloaded: u64, source: std::io::Error },
    Tampered {
        downloaded: u64,
        expected: String,
        actual: String,
    },
}

async fn persist_stream_to_file<S, B, E>(
    stream: &mut S,
    temp_path: &Path,
    expected_sha256: Option<&str>,
    chunk_timeout: std::time::Duration,
    mut on_progress: impl FnMut(u64),
) -> Result<(u64, String), PersistError<E>>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(temp_path)
        .await
        .map_err(PersistError::Create)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    loop {
        let chunk_opt = match tokio::time::timeout(chunk_timeout, stream.next()).await {
            Ok(Some(Ok(chunk))) => Some(chunk),
            Ok(Some(Err(e))) => {
                let _ = tokio::fs::remove_file(temp_path).await;
                return Err(PersistError::Stream {
                    downloaded,
                    source: e,
                });
            }
            Ok(None) => None,
            Err(_) => {
                let _ = tokio::fs::remove_file(temp_path).await;
                return Err(PersistError::Timeout { downloaded });
            }
        };
        let chunk = match chunk_opt {
            Some(c) => c,
            None => break,
        };
        let bytes = chunk.as_ref();
        if let Err(e) = file.write_all(bytes).await {
            let _ = tokio::fs::remove_file(temp_path).await;
            return Err(PersistError::Write {
                downloaded,
                source: e,
            });
        }
        hasher.update(bytes);
        downloaded += bytes.len() as u64;
        on_progress(downloaded);
    }
    let actual_hash = hex::encode(hasher.finalize());
    if let Some(expected) = expected_sha256 {
        let exp_clean = expected.trim().to_lowercase();
        if !exp_clean.is_empty() && actual_hash.to_lowercase() != exp_clean {
            let _ = tokio::fs::remove_file(temp_path).await;
            return Err(PersistError::Tampered {
                downloaded,
                expected: exp_clean,
                actual: actual_hash,
            });
        }
    }
    Ok((downloaded, actual_hash))
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

    let started = Instant::now();
    let log_file = file_base(asset_name);
    let safe_url = sanitize_url(download_url);
    let dl_req = crate::z_log::new_req_id();
    let dl_sid = crate::z_log::new_session_id();
    let dl_host = crate::log_support::host_of(download_url);
    log::info!(
        "download start sid={} req={} id={} host={} file={} url='{}'",
        dl_sid,
        dl_req,
        task_id,
        dl_host,
        log_file,
        safe_url
    );

    let resp_result = client.get(download_url).send().await;
    let resp = match resp_result {
        Ok(r) => {
            if !r.status().is_success() {
                let err_msg = format!("下载请求失败，HTTP 状态码: {}", r.status());
                log::error!(
                    "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                    task_id,
                    dl_sid,
                    dl_req,
                    dl_host,
                    log_file,
                    safe_url,
                    short_reason(&err_msg)
                );
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
            // reqwest Display 回显完整 URL（含签名 query）：先脱敏再记/再返回。
            let reason = http_err_reason(&e);
            let err_msg = format!("无法连接下载服务器: {}", reason);
            log::error!(
                "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file,
                safe_url,
                reason
            );
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
    let _ = tokio::fs::create_dir_all(&temp_dir).await;

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

    let mut stream = resp.bytes_stream();

    let mut last_emit = Instant::now();
    let mut last_bytes: u64 = 0;

    let chunk_timeout = std::time::Duration::from_secs(net_conf.chunk_timeout_seconds);
    let persist_result = persist_stream_to_file(
        &mut stream,
        &temp_path,
        expected_sha256,
        chunk_timeout,
        |downloaded| {
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
        },
    )
    .await;

    let (downloaded, actual_hash) = match persist_result {
        Ok(ok) => ok,
        Err(PersistError::Create(e)) => {
            let err_msg = format!("创建临时文件失败: {}", e);
            log::error!(
                "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file,
                safe_url,
                short_reason(&err_msg)
            );
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
        Err(PersistError::Stream { downloaded, source }) => {
            let reason = http_err_reason(&source);
            let err_msg = format!("下载数据流中断: {}", reason);
            log::error!(
                "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file,
                safe_url,
                reason
            );
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
        Err(PersistError::Timeout { downloaded }) => {
            let err_msg = format!(
                "下载超时：超过 {} 秒未接收到数据块，已中断连接",
                net_conf.chunk_timeout_seconds
            );
            log::error!(
                "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file,
                safe_url,
                short_reason(&err_msg)
            );
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
        Err(PersistError::Write { downloaded, source: e }) => {
            let err_msg = format!("写入磁盘失败: {}", e);
            log::error!(
                "download failed id={} sid={} req={} host={} file={} url='{}' reason={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file,
                safe_url,
                short_reason(&err_msg)
            );
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
        Err(PersistError::Tampered {
            downloaded,
            expected,
            actual,
        }) => {
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
                        expected, actual
                    )),
                },
            );
            // 校验失败：只记结论与短原因，不记哈希明细与路径。
            log::error!(
                "download verify failed id={} sid={} req={} host={} file={}",
                task_id,
                dl_sid,
                dl_req,
                dl_host,
                log_file
            );
            return Err(format!(
                "安全拦截：SHA-256 完整性校验不符！官方校验值: {}，实际下载文件: {}。已阻止潜在篡改软件的安装执行。",
                expected, actual
            ));
        }
    };

    // 零信任哈希比对防篡改核心拦截
    let (verified_state, verified_msg) = if let Some(expected) = expected_sha256 {
        let exp_clean = expected.trim().to_lowercase();
        if !exp_clean.is_empty() {
            if actual_hash.to_lowercase() != exp_clean {
                let _ = tokio::fs::remove_file(&temp_path).await;
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
                // 校验失败：只记结论与短原因，不记哈希明细与路径。
                log::error!(
                    "download verify failed id={} sid={} req={} host={} file={}",
                    task_id,
                    dl_sid,
                    dl_req,
                    dl_host,
                    log_file
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

    log::info!(
        "download done sid={} req={} id={} host={} file={} bytes={} elapsed_ms={}",
        dl_sid,
        dl_req,
        task_id,
        dl_host,
        log_file,
        downloaded,
        started.elapsed().as_millis()
    );
    Ok((temp_path, actual_hash))
}

#[cfg(test)]
mod persist_tests {
    use super::*;
    use futures_util::stream;
    use sha2::Digest;
    use std::time::Duration;

    fn test_chunks() -> Vec<Vec<u8>> {
        vec![b"hello ".to_vec(), b"world".to_vec(), b"!".to_vec()]
    }

    fn sha256_of(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }

    #[tokio::test]
    async fn download_persist_writes_bytes_and_reports_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let chunks = test_chunks();
        let expected_bytes = chunks.concat();
        let mut stream = stream::iter(chunks.into_iter().map(Ok::<_, String>));
        let mut progress: Vec<u64> = Vec::new();
        let (downloaded, hash) = persist_stream_to_file(
            &mut stream,
            &path,
            None,
            Duration::from_secs(5),
            |n| progress.push(n),
        )
        .await
        .expect("persist should succeed");
        assert_eq!(downloaded, expected_bytes.len() as u64);
        let on_disk = tokio::fs::read(&path).await.unwrap();
        assert_eq!(on_disk, expected_bytes);
        assert_eq!(hash, sha256_of(&expected_bytes));
        assert_eq!(progress.last().copied(), Some(downloaded));
    }

    #[tokio::test]
    async fn download_persist_matching_hash_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let chunks = test_chunks();
        let expected_bytes = chunks.concat();
        let good_hash = sha256_of(&expected_bytes);
        let mut stream = stream::iter(chunks.into_iter().map(Ok::<_, String>));
        let (downloaded, hash) = persist_stream_to_file(
            &mut stream,
            &path,
            Some(&good_hash),
            Duration::from_secs(5),
            |_| {},
        )
        .await
        .expect("matching hash should succeed");
        assert_eq!(downloaded, expected_bytes.len() as u64);
        assert_eq!(hash, good_hash);
        assert!(path.exists());
    }

    #[tokio::test]
    async fn download_persist_hash_mismatch_aborts_and_deletes_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let chunks = test_chunks();
        let mut stream = stream::iter(chunks.into_iter().map(Ok::<_, String>));
        let wrong = "0".repeat(64);
        let err = persist_stream_to_file(
            &mut stream,
            &path,
            Some(&wrong),
            Duration::from_secs(5),
            |_| {},
        )
        .await
        .expect_err("mismatch must fail");
        match err {
            PersistError::Tampered { .. } => {}
            _ => panic!("expected Tampered"),
        }
        assert!(
            !path.exists(),
            "temp file must be deleted on hash mismatch"
        );
    }

    #[tokio::test]
    async fn download_persist_stream_error_aborts_and_deletes_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let items: Vec<Result<Vec<u8>, String>> =
            vec![Ok(b"partial".to_vec()), Err("boom".to_string())];
        let mut stream = stream::iter(items);
        let err = persist_stream_to_file(
            &mut stream,
            &path,
            None,
            Duration::from_secs(5),
            |_| {},
        )
        .await
        .expect_err("stream error must fail");
        match err {
            PersistError::Stream { .. } => {}
            _ => panic!("expected Stream error"),
        }
        assert!(
            !path.exists(),
            "temp file must be deleted on stream error"
        );
    }
}
