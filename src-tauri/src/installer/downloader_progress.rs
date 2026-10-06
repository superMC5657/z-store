use crate::models::DownloadProgressPayload;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 异步落盘关键路径（P1-10a）的执行结果。
/// 携带调用方重现历史日志与发送 `zstore://download-progress` 事件所需的全部上下文。
#[derive(Debug)]
pub enum PersistError<E> {
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
pub async fn sha256_of_file(path: &Path) -> std::io::Result<(u64, String)> {
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
pub fn should_skip_download(local_len: u64, local_hash: &str, expected_sha256: &str) -> bool {
    local_len > 0
        && !expected_sha256.trim().is_empty()
        && crate::verify_sha256_str(local_hash, expected_sha256)
}

/// 已下载命中的终态收尾上下文：补发与正常成功一致的终态事件
/// （`verified`/`completed_unverified`）并直接返回，不发起/不消费网络 body。
pub struct SkipDone<'a> {
    pub app_handle: &'a tauri::AppHandle,
    pub task_id: &'a str,
    pub dl_sid: &'a str,
    pub dl_req: &'a str,
    pub dl_host: &'a str,
    pub log_file: &'a str,
    pub path: PathBuf,
    pub hash: String,
    pub size: u64,
    pub started: Instant,
    pub expected: Option<&'a str>,
}

impl<'a> SkipDone<'a> {
    pub fn finish(self) -> Result<(PathBuf, String), String> {
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

pub async fn persist_stream_to_file<S, B, E>(
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

#[cfg(test)]
mod tests {
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
