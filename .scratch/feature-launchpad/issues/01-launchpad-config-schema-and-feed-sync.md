# Issue 01: 开源广场配置段、SQLite 隔离快照表与 `get_launchpad_feed` 同步引擎

Status: ready-for-agent
Blocked by: none

## Summary

在客户端后端构建与 `catalog_apps` / `custom_apps` 物理隔离的开源广场（Launchpad）清单同步与缓存底座：

1. **统一配置中枢扩展（`src-tauri/config.toml` & `src-tauri/src/config.rs`）**：新增 `[launchpad]` 配置段（`default_source_url`、`discussions_repo`、`submit_issue_url`、`submit_web_url`）并同步更新配置基线单测。
2. **SQLite 独立二级快照表 `launchpad_feed_cache`（`src-tauri/src/db/schema.rs` & `src-tauri/src/db/launchpad.rs`）**：推进 `CURRENT_USER_VERSION = 8`，单条硬上限 `512 KiB`、保留最近 `3` 行与 `14 天` 离线窗口，随 `prune_bounded_caches` 有界清扫。
3. **无 Token 静态拉取、ETag 条件缓存、镜像回退、`pin_until` 实时过期分流与本地水合（`src-tauri/src/launchpad/` & `src-tauri/src/commands/launchpad.rs`）**：
   - 使用无凭据公开清单连接池（复用 `CatalogService::http_client` 通道，跟随 `ProxySnapshot`，绝不附带 OAuth/PAT 令牌）；
   - 接入 `api_etag_cache` 的 `If-None-Match` `304` 零带宽协商；首跳传输错误 / 429 / 5xx 时若为官方默认源且启用了加速镜像，经激活 `MirrorNode` 重试一次并执行严格 Schema + `canonical_app_id` 校验；全失败时降级读取 `launchpad_feed_cache` 并标记 `is_stale = true`；
   - 解析时按当前 `now_secs` 实时过滤 `pinned`：有效未过期的置顶条目（上限 `4` 个，按 `pin_order ASC`）进入 `spotlight`，已过期的条目自动撤下并合并进普通 `items` 流，同页同 `id` 严格去重；
   - 未收录条目非破坏性写入 `repo_card_cache`（跳过 `CatalogService::is_cataloged` 命中项，剥离 `data:` 图标），组装响应时单锁叠加 `CatalogService::stamp_summary`、`resolve_confirmed_icon_from_db` 及本地 `user_stars` 标星态，并为缺图标的 GitHub 项触发独立世代 `IconFetchCtx::Launchpad { gen }` 后台补图。

## Scope

- Allowed to modify:
  - `src-tauri/config.toml`
  - `src-tauri/src/config.rs`
  - `src-tauri/src/db/schema.rs`
  - `src-tauri/src/db/mod.rs`
  - `src-tauri/src/db/cache.rs`
  - `src-tauri/src/db/launchpad.rs`（新增）
  - `src-tauri/src/icons/fetch.rs`
  - `src-tauri/src/launchpad/mod.rs`（新增）
  - `src-tauri/src/launchpad/models.rs`（新增）
  - `src-tauri/src/commands/launchpad.rs`（新增）
  - `src-tauri/src/commands/mod.rs`
  - `src-tauri/src/lib.rs`（模块声明；注意：`generate_handler!` 注册在 Issue 03 与前端 `CMD` 表同批合入以保持 `cmdAlignment.test.ts` 常绿，或在本 Issue 暂不挂载 `generate_handler!` 仅导出 `commands::get_launchpad_feed`）
- Do not modify:
  - `src-tauri/src/repositories/catalog_repo.rs`、`catalog.json`（严禁混入精选目录）
  - `src/` 前端代码（在 Issue 03/04/05 处理）

## Implementation Details

### 1. `[launchpad]` 配置模型（`config.toml` & `config.rs`）

- `ProjectConfig` 增加 `#[serde(default)] pub launchpad: LaunchpadConfig`：
  - `default_source_url`: `"https://raw.githubusercontent.com/superMC5657/z-store-launchpad/main/launchpad.json"`
  - `discussions_repo`: `"superMC5657/z-store-launchpad"`
  - `submit_issue_url`: `"https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml"`
  - `submit_web_url`: `"https://z-store.org/launchpad/submit"`
- 同步更新 `config.rs` 中的 `serde_field_defaults_match_embedded_baseline` 与 `embedded_config_toml_declares_every_section` 测试（将 `"launchpad"` 加入必检段列表）。

### 2. SQLite `launchpad_feed_cache` 与迁移（`db/schema.rs` & `db/launchpad.rs`）

- `CURRENT_USER_VERSION` 升至 `8`，`migrate_v7_to_v8` 幂等创建 `launchpad_feed_cache(source_url TEXT PRIMARY KEY, payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL DEFAULT 0, cached_at INTEGER NOT NULL)`。
- 常量：`LAUNCHPAD_FEED_CACHE_MAX_BYTES = 512 * 1024`，`LAUNCHPAD_FEED_CACHE_MAX_ROWS = 3`，`LAUNCHPAD_SNAPSHOT_RETENTION_SECS = 14 * 86400`。
- 提供 `get_launchpad_feed_cache(&self, source_url: &str) -> Result<Option<(String, i64)>>`、`save_launchpad_feed_cache(&self, source_url: &str, payload_json: &str) -> Result<()>`、`prune_launchpad_feed_cache(&self, now: i64) -> Result<usize>`，并在 `prune_bounded_caches` 中调用。

### 3. `launchpad.json` 解析、分流与排序辅助纯函数（`src-tauri/src/launchpad/`）

- 定义远端信封 `RawLaunchpadManifest`（`version: u32`、`generated_at: Option<String>`、`discussions_repo: Option<String>`、`pinned: Vec<RawLaunchpadPin>`、`items: Vec<RawLaunchpadItem>`）与前端出站 `LaunchpadEntry` / `LaunchpadFeedResponse`（全字段 `snake_case`）：
  - `LaunchpadEntry` 内嵌 `summary: AppSummary`（复用全站卡片与详情契约），并附带：`maker_note: String`、`maker_note_en: Option<String>`、`maker: LaunchpadMaker { login, name, avatar_url, html_url }`、`launched_at: String`、`latest_release_at: Option<String>`、`stars_7d_delta: i64`、`discussion_repo: String`、`discussion_number: u64`、`discussion_node_id: Option<String>`、`discussion_url: String`、`discussion_comments_count: u64`、`discussion_upvotes: u64`、`is_pinned: bool`、`pin_until: Option<String>`、`pin_tier: Option<String>`、`viewer_has_starred: bool`。
- **置顶实时分流算法（纯函数 `partition_spotlight_and_recent(manifest, now_secs)`）**：
  - 校验 `manifest.version == 1`，条目 `id` 必须通过 `forge::canonical_app_id` 归一，非法行或重复 `id` 跳过并记 `debug` 日志，严禁因单条脏数据崩整页；
  - 解析每个 `pinned` 项的 RFC3339 `pin_until`：仅保留 `pin_until_ts > now_secs` 且在 `items` 中存在的项，按 `(pin_order ASC, id ASC)` 排序并截断前 `SPOTLIGHT_MAX_SLOTS = 4` 条作为 `spotlight`（标记 `is_pinned = true`）；
  - 其余所有条目（包括原未置顶项、置顶已过期项、以及超出 4 坑位上限的溢出项）统一置 `is_pinned = false` 进入 `items`（`Recent Launches`），保证整页同一规范 `id` 只出现一次。
- **图标流式上下文扩展（`icons/fetch.rs`）**：
  - `IconFetchCtx` 增加变体 `Launchpad { gen: u64 }`；`commands/launchpad.rs` 维护独立 `static LAUNCHPAD_ICON_GEN: AtomicU64`，对 `icon.trim().is_empty()` 且无确认图标的 GitHub 项异步调用 `fetch_icons_stream`。

## Acceptance Criteria

- [ ] Rust 单测覆盖 `partition_spotlight_and_recent`：
  - 未到期置顶项进入 `spotlight` 且不重复出现在 `items`；
  - `pin_until <= now_secs` 的到期置顶项自动降级进入 `items` 且 `is_pinned == false`；
  - 有效置顶超过 4 个时，`spotlight.len() == 4`，第 5 个自动回落至 `items`；
  - `data:` 图标在解析与写 `repo_card_cache` 时均被剥空。
- [ ] Rust 单测验证隔离性：执行清单落库水合后，`catalog_apps` 与 `custom_apps` 表行数为 `0`；未收录项正确写入 `repo_card_cache`，已存在于 `CatalogService` 的项跳过 `repo_card_cache` 并正确盖章 `is_cataloged == Some(true)`。
- [ ] Rust 单测验证缓存与降级：命中 `304` 零重复写盘返回缓存；远端失败时回退 `launchpad_feed_cache` 并置 `is_stale == true`；超 `512 KiB` 载荷被安全拒绝。
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
