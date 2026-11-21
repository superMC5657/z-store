# Issue 03: 统一 `AppDetail` 与轻量 Release 跨 `ForgeProvider` 决议并补齐多源校验清单

Status: resolved
Blocked by: 01, 02

## Summary

当前 `AppDetail`、`get_platforms_lite` 与 `fetch_app_latest_version_lightweight` 的编排散落在 `commands/catalog_detail.rs`（2,220 行）与 `commands/updates_check.rs`（846 行）中，造成三重架构摩擦与真实功能缺口：

1. **多源 `ForgeProvider` 接缝泄漏与功能残缺**：
   - `commands/catalog_detail.rs::fetch_detail_from_forge` 从不拉取 `Checksum Manifest`（因 `extract_checksums_map` 绑定在 `&[GitHubAssetResponse]` 上），导致 Codeberg、GitLab、Gitea 应用的所有 `ReleaseAsset` 恒为 `sha256: None`，安装时误触发无校验资产拦截弹窗；且非 GitHub 详情无失败旧缓存（`is_stale`）降级。
   - `forge/github.rs`（`GitHubProvider`）未走 `get_with_d7_retry_observed`（缺失 D7 有限重试与传输错误系统代理重探），也未在 401 时调用 `check_auth_expired`。
2. **重复的 9 步轻量 Release `ETag Cache` 仪式**：
   - `platforms_lite_from_github` 与 `fetch_app_latest_version_lightweight` 重复编写坐标解析、预读 `api_etag_cache`、`get_with_etag`、401 检查、`stale_row` 读取、`decide_shallow_release` 与 `touch_app_detail` / `save_etag`。
3. **命令层暴露多表持久化拼装细节**：
   - `fetch_detail_from_github` 发起 6 次独立 SQL 预读构造 `DetailEtagPrefetch`，`persist_github_detail`（135 行）在命令层手工缝合空 `releases`、修复占位简介、更新 `AppIconCycle`、写 `DetailRepository::persist_detail_bundle` 并同步内存 `CatalogService`。

本工单补齐 `ForgeProvider` 的 D7 重试与通用 `Checksum Manifest` 解析，并将完整详情与轻量 Release 决议收敛为一个深模块（演进 `DetailRepository` / `detail_service`）。

## Scope

- Allowed to modify:
  - `src-tauri/src/forge/mod.rs`
  - `src-tauri/src/forge/provider.rs`
  - `src-tauri/src/forge/github.rs`
  - `src-tauri/src/forge/gitlab.rs`
  - `src-tauri/src/forge/gitea.rs`
  - `src-tauri/src/forge/tests.rs`
  - `src-tauri/src/github/detail_fetch.rs`
  - `src-tauri/src/github/release_fetch.rs`
  - `src-tauri/src/repositories/detail_repo.rs`
  - `src-tauri/src/db/details.rs`（顺手清理零调用死代码 `save_detail_with_cycle_row`）
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src-tauri/src/commands/updates_check.rs`
- Do not modify:
  - `src/` 前端代码
  - `src-tauri/src/commands/catalog_search.rs`（留待 Issue 04 处理）

## Implementation Details

1. **加固 `ForgeProvider` 多源一致性与通用 `Checksum Manifest` 提取**：
   - `forge/github.rs`：`fetch_repo` 与 `fetch_latest_release` 改用 `super::http::get_with_d7_retry_observed`（对齐 `gitlab.rs` / `gitea.rs` 的 D7 有限重试与代理快照重探），并在 HTTP 401 时调用 `crate::check_auth_expired`。
   - 将 `Checksum Manifest` 提取泛化为面向 `&mut [ReleaseAsset]`（或 `(name, download_url)` 投影）的公共函数（仍严格遵守 ADR-0004 / ADR-0025：恒走原始 `download_url` 直连/系统代理、硬超时 `CHECKSUM_FETCH_TIMEOUT`、**绝不经下载镜像改写**），使 GitHub 与非 GitHub `ForgeProvider` 详情拉取共用同一套 `checksums.txt` / `SHA256SUMS` 哈希填充逻辑。
   - 所有非 GitHub 主机令牌查询统一走 Issue 02 建立的 `oauth::resolve_host_token`。
2. **将 `AppDetail` 与轻量 Release 编排下沉为单一深模块（`repositories/detail_repo.rs` 或 `detail_service`）**：
   - 对外仅暴露高杠杆 **interface**（支持注入测试 HTTP 基址或 `ForgeProvider` **adapter**）：
     - `resolve_app_detail(...) -> AppResult<AppDetail>`：内部统一封装 `Cache TTL` 命中投影、GitHub ETag 三路并发与多源 `ForgeProvider` 拉取、`Checksum Manifest` 填充、失败时本地 `is_stale = Some(true)` 降级、空 `releases` 与占位简介自愈、`AppIconCycle` 归并、`persist_detail_bundle` 同事务落盘、`CatalogService` 内存回写以及后台确认图标落盘预热。
     - `resolve_platforms_lite(...) -> AppResult<PlatformsLiteResult>`：内部统一封装详情 TTL 快径、`repo_card_cache` 12h 三态快径、GitHub ETag 轻量探查与非 GitHub `ForgeProvider` Release 探查、`patch_repo_card_platforms` 写回及 `CatalogService` 平台回填。
     - `resolve_latest_release_lightweight(...) -> Result<LightweightRelease, String>`：封装资产面 `force_refresh == false` 纯本地三级回退（`update_results` → `app_details` → `Catalog` 默认版本）与 `force_refresh == true` 时的跨 Forge 轻量 Release 探查及 `apply_release_cache_effects` 副作用落库。
   - 批量合并 `DetailEtagPrefetch` 预读查询，删除 `db/details.rs` 中未使用的 `save_detail_with_cycle_row`。
3. **瘦身命令层**：
   - `commands/catalog_detail.rs` 与 `commands/updates_check.rs` 移除 `ForgeType` 分支拼装、`persist_github_detail` 与手工 ETag 编排，仅保留参数校验、并发进度流发射与命令返回映射。

## Acceptance Criteria

- [ ] Codeberg / GitLab / Gitea 详情拉取在 Release 含 `checksums.txt` / `SHA256SUMS` 时可正确填充 `ReleaseAsset.sha256`，网络失败且本地有旧详情时可回退返回 `is_stale = Some(true)`。
- [ ] `GitHubProvider` 接入 `get_with_d7_retry_observed` 并在 401 响应时触发 `check_auth_expired`。
- [ ] 基于 `Database::open_in_memory()` 与本地 `test_support::serve` Mock HTTP 服务，单测直接通过加深后详情模块的 **interface** 验证：TTL 命中、304 保鲜、多源 `Checksum Manifest` 解析、`repo_card_cache` 同事务更新与 `platforms_lite` 三态写回。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` 全部通过。
