# Issue 03: HTTP D7 重试契约统一、开发者画像接入 `ETag Cache` 与连接池完善

Status: needs-triage
Blocked by: none

## Summary

将分散的 HTTP 重试逻辑收敛至符合 `CONTEXT.md` D7 规范的共享执行器，为 `get_developer_profile` 接入已有的 `api_etag_cache` 持久化路径，并补齐清单镜像与下载连接池的复用策略。

## Scope

- Allowed to modify:
  - `src-tauri/src/forge/http.rs`
  - `src-tauri/src/github/http.rs`
  - `src-tauri/src/github/detail_fetch.rs`
  - `src-tauri/src/github/discussions.rs`
  - `src-tauri/src/commands/forge.rs`
  - `src-tauri/src/github/developer_profile.rs`
  - `src-tauri/src/github/catalog_service.rs`
  - `src-tauri/src/launchpad/mod.rs`
  - `src-tauri/src/installer/downloader_http.rs`
- Do not modify:
  - `src/*`

## Implementation Details

1. **统一 D7 GET 重试核心 (`forge/http.rs` & `github/http.rs`)**：
   - 将 `github/http.rs::get_with_etag_diag_inner` 中的 D7 重试策略（仅 GET；传输错误 `is_timeout/is_connect` 触发 `proxy::refresh_after_transport_error` 换池 + 200ms→800ms 退避；429 按 `retry_after_delay_ms`；5xx 按 200ms→800ms；最多 2 次；401/404/304 永不重试）下沉为 `forge/http.rs` 的共享执行函数。
   - 让 `forge::http::get_with_retry_after_once`（GitLab / Gitea `ForgeProvider`）与 `github::http::get_with_etag_diag_inner` 共同基于该执行器实现，消除行为不一致（目前 GitLab/Gitea 5xx 不重试且传输错误无退避）。
2. **`get_developer_profile` 接入 `api_etag_cache` (`commands/forge.rs` & `github/developer_profile.rs`)**：
   - `commands/forge.rs::get_developer_profile` 改为短锁从 `state.db()` 预读 `dev_user_endpoint` 与 `dev_repos_endpoint` 的 `(etag, payload)`，调用 `fetch_developer_profile_with_cache`，并在返回 `200`/`304` 后短锁写入/刷新 `api_etag_cache`（与 `list_github_starred` / `get_app_details` 同构）。
   - 同时确认 `developer_profile.rs` 复用 `crate::shared_http_client()` / `new_api_client`，且对 `Unauthorized` 状态上报 `check_auth_expired(401, ...)`。
3. **修复 `detail_fetch.rs` 误传 Release ETag/API 头给 Checksum 下载请求，并并发独立请求**：
   - **Defect 修复（`github/detail_fetch.rs:710-716, 733, 887, 1032`）**：当前第 710–716 行构建了含 `releases/latest` `If-None-Match` 的 `headers` 但未传给第 733 行 Release 请求，反而于第 887 行将其连同 GitHub API `Accept`/`Authorization` 头一并传给了 `fetch_checksum_table`（`extract_checksums_map:1032`），导致向 `checksums.txt` 下载直链发送错误的 ETag 与鉴权头。删去冗余 `headers`，`fetch_checksum_table` 改用干净的下载头。
   - **HTTP 并发化**：`github/developer_profile.rs:65, 141`（`/users/{dev}` 与 `/users/{dev}/repos`）及 `github/discussions.rs:711-729`（`fetch_discussion_anonymous` 的 discussion 与 comments 请求）改为 `tokio::join!` 并发拉取。
4. **镜像清单池与下载池替换策略完善**：
   - `CatalogService` 与 `launchpad/mod.rs`（`launchpad:313`）增加镜像回退专用 `ClientSlot`（key 为 `snap.signature(&extra_hosts)`），避免每次镜像回退重建 `reqwest::Client`；并收敛两者的 `fetch_with_fallback` 公共重试骨架。
   - `DOWNLOAD_CLIENTS` (`installer/downloader_http.rs:47-49`) 满 `DOWNLOAD_CLIENT_POOL_CAP` (8) 时改为移除最久未访问或最先插入的单条记录（LRU/FIFO），而非 `guard.clear()` 清空全部活跃池。

## Acceptance Criteria

- [ ] `ForgeProvider`（GitHub / GitLab / Gitea / Codeberg）全部遵循统一的 D7 重试策略。
- [ ] `get_developer_profile` 连续访问同一开发者主页时发送 `If-None-Match` 并在 304 时零配额复用 `api_etag_cache` 载荷。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 全部通过。
