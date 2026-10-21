# Issue 15: 非 GitHub forge 限流口径不一致 + 伪造配额 + sleep 竞态

Status: resolved
Priority: P2（正确性）
来源: 2026-10-21 全项目审查 · Rust 架构分片

## 描述

1. 仅 GitHubProvider 走 span.notify 上报配额；gitea/gitlab 的 fetch_repo/search 无
   429/Retry-After 处理——三家限流口径不一致。
2. `src-tauri/src/github/http.rs:47`：`get_with_etag` 固定 200/800ms 退避，不读
   Retry-After（CONTEXT.md D7 声明 429 属可重试，但未消费服务端指示）。
3. `src-tauri/src/commands/forge.rs:99`：`refresh_host_rate_limit` 靠 `sleep(60ms)` 等
   配额事件落库，竞态下返回陈旧 None。
4. `src-tauri/src/commands/forge.rs:200-206`：无 x-ratelimit 头时 `or(Some(5000))`
   伪造配额数值展示。

## 修复方向

- Retry-After 消费下沉到 `get_with_etag` 统一处理（上限对齐 D9 的 60s 缺省 5s 口径）。
- gitea/gitlab 接入同一 span.notify 配额上报。
- `refresh_host_rate_limit` 改为等待事件通知（notify oneshot/channel）而非固定 sleep；
  无头时返回 unknown 而非伪造 5000。

## Comments

- **三家口径对齐**：gitea.rs / gitlab.rs 全部 7 个响应点（fetch_repo / fetch_latest_release
  （含 GitLab `/releases` 列表回退）/ search_repos）接入 `span.notify(&resp, host)`，
  与 GitHubProvider 同构；`HttpSpan` doc 注释同步更正。x-ratelimit 头不存在时
  `notify_rate_limit` 为 no-op，自建实例不受影响。
- **Retry-After 下沉**：`github/http.rs` 新增纯函数 `retry_after_delay_ms`
  （秒→ms、上限 60s、缺失/非数字缺省 5s，对齐 D9 口径）；`get_with_etag` 重试循环
  429 优先服务端 Retry-After（带 retry_after_ms 日志），5xx/传输错误保持 D7 固定
  200→800ms 退避，重试上限仍为 2 次。
- **sleep 竞态根治（机制微调说明）**：`refresh_host_rate_limit` 删除 `sleep(60ms)`，
  改为 `probe_and_announce_rate_limit` 返回响应头提取的 `(remaining, limit, reset)`
  三元组，经 `overlay_probed_quota` 对读出的 entry **确定性覆写**。未走 channel 等待
  的原因：全局事件通道无 host 关联能力（他 host 事件会误唤醒，竞态仅缩小未消除），
  覆写按构造消除竞态且语义更强（返回值即真相源）；事件通道照常异步落库/emit 前端，
  其他消费方不受影响。
- **伪造配额移除**：`test_host_connection` Gitea 分支两处 `.or(Some(5000))` 删除，
  无 x-ratelimit 头时保持 `None`（unknown），不再伪造数值误导前端展示。
- **测试**：新增 `retry_after_delay_ms` 钳制/缺省用例与 `overlay_probed_quota`
  覆写/保原值用例；cargo test 356 全绿，`cargo clippy -- -D warnings` 干净。
