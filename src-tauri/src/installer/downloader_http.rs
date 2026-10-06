use super::downloader_progress::{
    persist_stream_to_file, sha256_of_file, should_skip_download, PersistError, SkipDone,
};
use crate::log_support::{file_base, http_err_reason, sanitize_url, short_reason};
use crate::models::DownloadProgressPayload;
use std::path::{Path, PathBuf};
use std::time::Instant;

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
        crate::installer::paths::default_download_dir()
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
