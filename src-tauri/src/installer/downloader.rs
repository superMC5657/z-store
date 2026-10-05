use crate::log_support::{file_base, http_err_reason, sanitize_url, short_reason};
use crate::models::DownloadProgressPayload;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 异步落盘关键路径（P1-10a）的执行结果。
/// 携带调用方重现历史日志与发送 `zstore://download-progress` 事件所需的全部上下文。
#[derive(Debug)]
enum PersistError<E> {
    Create(std::io::Error),
    Stream {
        downloaded: u64,
        source: E,
    },
    Timeout {
        downloaded: u64,
    },
    Write {
        downloaded: u64,
        source: std::io::Error,
    },
    Tampered {
        downloaded: u64,
        expected: String,
        actual: String,
    },
}

/// 计算已存在文件的 `(大小, SHA-256 hex)`，供“已下载跳过”校验与回填返回哈希。
async fn sha256_of_file(path: &Path) -> std::io::Result<(u64, String)> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut len: u64 = 0;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok((len, hex::encode(hasher.finalize())))
}

/// 已下载跳过判定（纯函数）：只认 SHA256——本地存在且大小>0，且与期望哈希一致。
/// 无期望哈希一律不跳过（由调用方保证只在期望非空时调用）。
fn should_skip_download(local_len: u64, local_hash: &str, expected_sha256: &str) -> bool {
    local_len > 0
        && !expected_sha256.trim().is_empty()
        && crate::verify_sha256_str(local_hash, expected_sha256)
}

/// 已下载命中的终态收尾上下文：补发与正常成功一致的终态事件
/// （`verified`/`completed_unverified`）并直接返回，不发起/不消费网络 body。
struct SkipDone<'a> {
    app_handle: &'a tauri::AppHandle,
    task_id: &'a str,
    dl_sid: &'a str,
    dl_req: &'a str,
    dl_host: &'a str,
    log_file: &'a str,
    path: PathBuf,
    hash: String,
    size: u64,
    started: Instant,
    expected: Option<&'a str>,
}

impl<'a> SkipDone<'a> {
    fn finish(self) -> Result<(PathBuf, String), String> {
        let (verified_state, verified_msg) = match self.expected {
            Some(expected) if !expected.trim().is_empty() => (
                "verified".to_string(),
                format!("已通过官方 SHA-256 完整性校验: {}", self.hash),
            ),
            _ => (
                "completed_unverified".to_string(),
                format!(
                    "上游未提供官方校验清单，已记录本地计算 SHA-256: {}",
                    self.hash
                ),
            ),
        };
        DownloadProgressPayload::emit_event(
            self.app_handle,
            self.task_id,
            self.size,
            self.size,
            0,
            &verified_state,
            Some(verified_msg),
        );
        log::info!(
            "download skipped sid={} req={} id={} host={} file={} bytes={} elapsed_ms={}",
            self.dl_sid,
            self.dl_req,
            self.task_id,
            self.dl_host,
            self.log_file,
            self.size,
            self.started.elapsed().as_millis()
        );
        Ok((self.path, self.hash))
    }
}

async fn persist_stream_to_file<S, B, E>(
    stream: &mut S,
    tmp_path: &Path,
    expected_sha256: Option<&str>,
    chunk_timeout: std::time::Duration,
    mut on_progress: impl FnMut(u64),
) -> Result<(u64, String), PersistError<E>>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(tmp_path)
        .await
        .map_err(PersistError::Create)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    loop {
        let chunk_opt = match tokio::time::timeout(chunk_timeout, stream.next()).await {
            Ok(Some(Ok(chunk))) => Some(chunk),
            Ok(Some(Err(e))) => {
                let _ = tokio::fs::remove_file(tmp_path).await;
                return Err(PersistError::Stream {
                    downloaded,
                    source: e,
                });
            }
            Ok(None) => None,
            Err(_) => {
                let _ = tokio::fs::remove_file(tmp_path).await;
                return Err(PersistError::Timeout { downloaded });
            }
        };
        let chunk = match chunk_opt {
            Some(c) => c,
            None => break,
        };
        let bytes = chunk.as_ref();
        if let Err(e) = file.write_all(bytes).await {
            let _ = tokio::fs::remove_file(tmp_path).await;
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
        let exp_clean = expected.trim();
        if !exp_clean.is_empty() && !crate::verify_sha256_str(&actual_hash, exp_clean) {
            let _ = tokio::fs::remove_file(tmp_path).await;
            return Err(PersistError::Tampered {
                downloaded,
                expected: exp_clean.to_lowercase(),
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
    // 下载器独立 Client：直建，超时全部取 config。
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Z-Store/0.1.0")
        .connect_timeout(std::time::Duration::from_secs(net_conf.connect_timeout_seconds))
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(net_conf.download_timeout_seconds))
        .build()
        .map_err(|e| e.to_string())?;
    let chunk_timeout = std::time::Duration::from_secs(net_conf.chunk_timeout_seconds);

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

    // 落盘目标：直接写入最终文件（失败时落盘函数清理半文件）。
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
    let final_path = temp_dir.join(file_name);

    // 已下载跳过：只认 SHA256。expected 非空且本地文件存在、大小>0 时对一次哈希，
    // 对上则零网络返回；对不上/无期望哈希一律正常下载覆盖。
    if let Some(expected) = expected_sha256 {
        if !expected.trim().is_empty() {
            let local_len = tokio::fs::metadata(&final_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            if local_len > 0 {
                if let Ok((_, actual)) = sha256_of_file(&final_path).await {
                    if should_skip_download(local_len, &actual, expected) {
                        return SkipDone {
                            app_handle,
                            task_id,
                            dl_sid: &dl_sid,
                            dl_req: &dl_req,
                            dl_host: &dl_host,
                            log_file: &log_file,
                            path: final_path,
                            hash: actual,
                            size: local_len,
                            started,
                            expected: expected_sha256,
                        }
                        .finish();
                    }
                }
            }
        }
    }

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
                DownloadProgressPayload::emit_event(
                    app_handle,
                    task_id,
                    0,
                    0,
                    0,
                    "error",
                    Some(err_msg.clone()),
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
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                0,
                0,
                0,
                "error",
                Some(err_msg.clone()),
            );
            return Err(err_msg);
        }
    };

    let total_bytes = resp.content_length().unwrap_or(0);

    // 原子落盘：先写 `.tmp`，成功后 rename 到最终路径；失败删 tmp，
    // 半文件不污染下次跳过（跳过只认最终文件的 SHA256）。
    let tmp_path = {
        let mut s = final_path.as_os_str().to_owned();
        s.push(".tmp");
        PathBuf::from(s)
    };

    let mut stream = resp.bytes_stream();

    let mut last_emit = Instant::now();
    let mut last_bytes: u64 = 0;

    let persist_result = persist_stream_to_file(
        &mut stream,
        &tmp_path,
        expected_sha256,
        chunk_timeout,
        |downloaded| {
            if last_emit.elapsed().as_millis() >= 200
                || (total_bytes > 0 && downloaded == total_bytes)
            {
                let elapsed_secs = last_emit.elapsed().as_secs_f64().max(0.001);
                let speed = ((downloaded - last_bytes) as f64 / elapsed_secs) as u64;

                DownloadProgressPayload::emit_event(
                    app_handle,
                    task_id,
                    downloaded,
                    total_bytes,
                    speed,
                    "downloading",
                    None,
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
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                0,
                0,
                0,
                "error",
                Some(err_msg.clone()),
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
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                downloaded,
                total_bytes,
                0,
                "error",
                Some(err_msg.clone()),
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
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                downloaded,
                total_bytes,
                0,
                "error",
                Some(err_msg.clone()),
            );
            return Err(err_msg);
        }
        Err(PersistError::Write {
            downloaded,
            source: e,
        }) => {
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
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                downloaded,
                total_bytes,
                0,
                "error",
                Some(err_msg.clone()),
            );
            return Err(err_msg);
        }
        Err(PersistError::Tampered {
            downloaded,
            expected,
            actual,
        }) => {
            DownloadProgressPayload::emit_event(
                app_handle,
                task_id,
                downloaded,
                downloaded,
                0,
                "tampered",
                Some(format!("哈希不符！期望: {}, 实际: {}", expected, actual)),
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

    // 成功后 rename 到最终路径；Windows rename 不覆盖已存在目标，先删后改。
    // 此处旧最终文件（若有）必是哈希未命中的脏文件，删了重建即可。
    let _ = tokio::fs::remove_file(&final_path).await;
    if let Err(e) = tokio::fs::rename(&tmp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
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
        DownloadProgressPayload::emit_event(
            app_handle,
            task_id,
            downloaded,
            total_bytes,
            0,
            "error",
            Some(err_msg.clone()),
        );
        return Err(err_msg);
    }

    // 零信任哈希终态判定：不符已在落盘时以 Tampered 中断并删文件，
    // 能执行到此处说明已通过官方校验或上游未提供期望值，此处只做终态分支，不再重复比对。
    let (verified_state, verified_msg) = match expected_sha256 {
        Some(expected) if !expected.trim().is_empty() => (
            "verified".to_string(),
            format!("已通过官方 SHA-256 完整性校验: {}", actual_hash),
        ),
        _ => (
            "completed_unverified".to_string(),
            format!(
                "上游未提供官方校验清单，已记录本地计算 SHA-256: {}",
                actual_hash
            ),
        ),
    };

    DownloadProgressPayload::emit_event(
        app_handle,
        task_id,
        downloaded,
        downloaded,
        0,
        &verified_state,
        Some(verified_msg),
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
    Ok((final_path, actual_hash))
}

#[cfg(test)]
mod persist_tests {
    use super::*;
    use futures_util::stream;
    use std::time::Duration;

    fn test_chunks() -> Vec<Vec<u8>> {
        vec![b"hello ".to_vec(), b"world".to_vec(), b"!".to_vec()]
    }

    fn sha256_of(data: &[u8]) -> String {
        crate::sha256_digest_hex(data)
    }

    #[tokio::test]
    async fn download_persist_writes_bytes_and_reports_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let chunks = test_chunks();
        let expected_bytes = chunks.concat();
        let mut stream = stream::iter(chunks.into_iter().map(Ok::<_, String>));
        let mut progress: Vec<u64> = Vec::new();
        let (downloaded, hash) =
            persist_stream_to_file(&mut stream, &path, None, Duration::from_secs(5), |n| {
                progress.push(n)
            })
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
        assert!(!path.exists(), "file must be deleted on hash mismatch");
    }

    #[tokio::test]
    async fn download_persist_stream_error_aborts_and_deletes_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("package.bin");
        let items: Vec<Result<Vec<u8>, String>> =
            vec![Ok(b"partial".to_vec()), Err("boom".to_string())];
        let mut stream = stream::iter(items);
        let err = persist_stream_to_file(&mut stream, &path, None, Duration::from_secs(5), |_| {})
            .await
            .expect_err("stream error must fail");
        match err {
            PersistError::Stream { .. } => {}
            _ => panic!("expected Stream error"),
        }
        assert!(!path.exists(), "file must be deleted on stream error");
    }

    #[test]
    fn download_skip_existing_file_decision() {
        let data = b"hello world!".to_vec();
        let good = sha256_of(&data);
        let bad = "0".repeat(64);
        let len = data.len() as u64;
        // 命中：大小>0 且哈希一致（零网络）。
        assert!(should_skip_download(len, &good, &good));
        // 大小写不敏感同样命中。
        assert!(should_skip_download(len, &good.to_uppercase(), &good));
        // 哈希不匹配 → 重下覆盖。
        assert!(!should_skip_download(len, &bad, &good));
        // 空文件 → 重下。
        assert!(!should_skip_download(0, &good, &good));
        // 期望哈希为空 → 重下（无期望哈希一律不跳过）。
        assert!(!should_skip_download(len, &good, ""));
        assert!(!should_skip_download(len, &good, "  "));
    }
}
