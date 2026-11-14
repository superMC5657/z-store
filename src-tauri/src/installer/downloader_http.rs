use super::downloader_progress::{
    persist_stream_to_file, sha256_of_file, should_skip_download, verify_terminal_state,
    DownloadTraceMeta, PersistError, SkipDone,
};
use crate::log_support::{file_base, http_err_reason, short_reason};
use crate::models::DownloadProgressPayload;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const DOWNLOAD_CLIENT_POOL_CAP: usize = 8;
static DOWNLOAD_CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();

fn build_download_client(
    snap: &crate::proxy::ProxySnapshot,
    dl_extra: &[String],
) -> Result<reqwest::Client, String> {
    let net_conf = &crate::config::get_project_config().network;
    let dl_builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZStore/0.1.0")
        .connect_timeout(std::time::Duration::from_secs(net_conf.connect_timeout_seconds))
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(net_conf.download_timeout_seconds));
    crate::proxy::apply_proxy_snapshot(dl_builder, snap, dl_extra)
        .build()
        .map_err(|e| e.to_string())
}

/// 下载池键：含直连豁免 host 的代理签名；系统代理变化即换键重建，上限 8 条超限整体清空。
fn download_pool_key(snap: &crate::proxy::ProxySnapshot, dl_extra: &[String]) -> String {
    // 签名已合并 `dl_extra`（`np=` 段），无需另拼。
    snap.signature(dl_extra)
}

fn resolve_download_client(dl_extra: &[String]) -> Result<reqwest::Client, String> {
    let snap = crate::proxy::current_proxy_snapshot();
    let key = download_pool_key(&snap, dl_extra);
    let pool = DOWNLOAD_CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = pool.lock() {
        if let Some(existing) = guard.get(&key) {
            return Ok(existing.clone());
        }
    }
    let client = build_download_client(&snap, dl_extra)?;
    if let Ok(mut guard) = pool.lock() {
        if guard.len() >= DOWNLOAD_CLIENT_POOL_CAP && !guard.contains_key(&key) {
            guard.clear();
        }
        guard.insert(key, client.clone());
    }
    Ok(client)
}

fn log_download_fail(meta: DownloadTraceMeta<'_>, reason: &str) {
    let mut ev = meta.wide_event("failed", true);
    ev.field("host", meta.dl_host)
        .field("reason", reason)
        .dev_url("url", meta.download_url);
    ev.error();
}

/// `bypass_proxy_hosts`：仅实际生效的镜像 host（见 `mirror::ResolvedDownloadUrl`）；
/// 官方直连传空，`github.com` / `codeberg.org` 等上游资产完整继承系统代理。
pub async fn download_with_progress(
    app_handle: &tauri::AppHandle,
    task_id: &str,
    download_url: &str,
    bypass_proxy_hosts: &[String],
    asset_name: &str,
    expected_sha256: Option<&str>,
    custom_download_dir: Option<&Path>,
) -> Result<(PathBuf, String), String> {
    let net_conf = &crate::config::get_project_config().network;
    let client = resolve_download_client(bypass_proxy_hosts)?;
    let chunk_timeout = std::time::Duration::from_secs(net_conf.chunk_timeout_seconds);

    let started = Instant::now();
    let log_file = file_base(asset_name);
    let dl_trace = crate::z_log::new_trace_id();
    let dl_host = crate::log_support::host_of(download_url);
    let trace_meta = DownloadTraceMeta {
        task_id,
        dl_trace: &dl_trace,
        dl_host: &dl_host,
        log_file: &log_file,
        download_url,
        started,
    };
    let mut start_ev = trace_meta.wide_event("start", false);
    start_ev
        .field("host", &dl_host)
        .dev_url("url", download_url);
    start_ev.info();

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
                            meta: trace_meta,
                            path: final_path,
                            hash: actual,
                            size: local_len,
                            expected: expected_sha256,
                        }
                        .finish();
                    }
                }
            }
        }
    }

    let resp_result = client.get(download_url).send().await;
    if let Err(ref e) = resp_result {
        // 失败即失效快照：紧随其后的镜像兜底/用户重试立即感知代理变化。
        crate::proxy::note_transport_error(e);
    }
    let resp = match resp_result {
        Ok(r) => {
            if !r.status().is_success() {
                let err_msg = format!("下载请求失败，HTTP 状态码: {}", r.status());
                log_download_fail(trace_meta, &short_reason(&err_msg));
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
            log_download_fail(trace_meta, &reason);
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

    // 原子落盘：先写唯一 `.tmp`（进程 id + 纳秒后缀），成功后 rename 到最终路径；
    // 失败时落盘函数清理半文件。唯一名防并发同名任务互写同一临时文件导致
    // 字节交错成损坏包（各自哈希自洽但落盘混合）。
    let tmp_path = {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let mut s = final_path.as_os_str().to_owned();
        s.push(format!(".{}.{}.tmp", std::process::id(), nanos));
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
            log_download_fail(trace_meta, &short_reason(&err_msg));
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
            log_download_fail(trace_meta, &reason);
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
            log_download_fail(trace_meta, &short_reason(&err_msg));
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
            log_download_fail(trace_meta, &short_reason(&err_msg));
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
            let mut ev = trace_meta.wide_event("verify failed", true);
            ev.dev("host", &dl_host);
            ev.error();
            return Err(format!(
                "安全拦截：SHA-256 完整性校验不符！官方校验值: {}，实际下载文件: {}。已阻止潜在篡改软件的安装执行。",
                expected, actual
            ));
        }
    };

    // 成功后 rename 到最终路径；Windows rename 不覆盖已存在目标，先删后改。
    let mut rename_ok = false;
    let mut last_rename_err: Option<std::io::Error> = None;
    for _ in 0..5 {
        let _ = tokio::fs::remove_file(&final_path).await;
        match tokio::fs::rename(&tmp_path, &final_path).await {
            Ok(()) => {
                rename_ok = true;
                break;
            }
            Err(e) => {
                last_rename_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
    if !rename_ok {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        let err_msg = format!(
            "写入磁盘失败: {}",
            last_rename_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "未知错误".to_string())
        );
        log_download_fail(trace_meta, &short_reason(&err_msg));
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

    let (verified_state, verified_msg) = verify_terminal_state(expected_sha256, &actual_hash);

    DownloadProgressPayload::emit_event(
        app_handle,
        task_id,
        downloaded,
        downloaded,
        0,
        &verified_state,
        Some(verified_msg),
    );

    let mut done_ev = trace_meta.wide_event("done", true);
    done_ev
        .field("bytes", downloaded)
        .dev("host", &dl_host)
        .dev("verified", verified_state == "verified")
        .dev_url("url", download_url);
    done_ev.info();
    Ok((final_path, actual_hash))
}

#[cfg(test)]
mod tests {
    use super::download_pool_key;
    use crate::proxy::ProxySnapshot;
    use crate::test_support::proxied_snapshot;

    #[test]
    fn download_pool_key_tracks_proxy_signature_and_bypass_hosts() {
        let direct = ProxySnapshot::direct();
        let proxied = proxied_snapshot("http://127.0.0.1:7890");
        let none: Vec<String> = Vec::new();
        // 自定义镜像 host 才改变豁免集合（`gh-proxy.com` 已在默认豁免中，同池复用）。
        let mirror = vec!["mirror.example.com".to_string()];
        let gh_proxy = vec!["gh-proxy.com".to_string()];
        assert_eq!(download_pool_key(&direct, &none), download_pool_key(&direct, &none));
        assert_ne!(download_pool_key(&direct, &none), download_pool_key(&proxied, &none));
        assert_ne!(download_pool_key(&proxied, &none), download_pool_key(&proxied, &mirror));
        assert_eq!(download_pool_key(&proxied, &none), download_pool_key(&proxied, &gh_proxy));
        // 官方直连（无豁免）的键不含上游 forge host。
        assert!(!download_pool_key(&proxied, &none).contains("github.com"));
    }
}
