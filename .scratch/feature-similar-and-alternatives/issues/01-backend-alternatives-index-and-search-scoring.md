# Issue 01: 商业软件「开源平替」元数据映射、字段扩展与检索评分升级

Status: resolved
Blocked by: none

## Summary

在后端目录模型与本地搜索引擎中引入「商业软件开源平替（`alternatives`）」字段及内置精选平替映射字典，并将 `CatalogService::search_local_catalog` 的匹配层级扩展至支持商业平替关键词与中英简介整词检索，使搜索 `TeamViewer`、`Notion`、`Postman` 等商业软件时能够精准命中并高优先级召回对应的开源替代软件。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/alternatives.rs`（新增）
  - `src-tauri/src/github/mod.rs`（声明 `pub mod alternatives;`）
  - `src-tauri/src/github/models.rs`（`CatalogItem` 新增可选 `alternatives: Vec<String>`）
  - `src-tauri/src/models.rs`（`AppCore` 新增可选 `alternatives: Vec<String>`）
  - `src-tauri/src/github/catalog_feed_score.rs`（新增 `SEARCH_SCORE_ALTERNATIVE_MATCH` 与 `SEARCH_SCORE_DESCRIPTION_CONTAINS` 常量）
  - `src-tauri/src/github/catalog_service.rs`（更新 `search_score` 与 `CatalogItem::to_summary` 投影）
  - `src-tauri/src/github/tests.rs`（补充搜索平替回归测试）
- Do not modify:
  - `catalog.json`（保持与 `z-store-catalog` 独立仓同步口径，不强行改写全量种子文件）
  - `src/` 前端代码（在 Issue 03 处理）
  - `src-tauri/src/commands/`（在 Issue 02 处理）

## Implementation Details

1. **新增 `src-tauri/src/github/alternatives.rs`**：
   - 提供静态映射表 `builtin_alternatives_for(canonical_id: &str) -> &'static [&'static str]`，覆盖常见开源平替组合（如 `rustdesk/rustdesk` → `["TeamViewer", "AnyDesk", "ToDesk", "向日葵"]`、`localsend/localsend` → `["AirDrop", "隔空投送"]`、`usememos/memos` / `logseq/logseq` / `toeverything/affine` / `appflowy-io/appflowy` → `["Notion", "Flomo", "Obsidian"]`、`usebruno/bruno` / `hoppscotch/hoppscotch` → `["Postman", "Insomnia", "Apifox"]`、`keepassxreboot/keepassxc` / `bitwarden/clients` → `["1Password", "LastPass"]`、`ventoy/ventoy`、`mpv-player/mpv` / `videolan/vlc` → `["PotPlayer"]`、`obsproject/obs-studio`、`gimp-gnome/gimp` / `darktable-org/darktable` / `kdenlive`、`dbeaver/dbeaver` → `["Navicat", "DataGrip"]`、`voidtools` 类检索平替、压缩与下载工具等至少 25 组主流开源条目）。
   - 提供 `resolved_alternatives(explicit: &[String], canonical_id: &str) -> Vec<String>`：将显式 `CatalogItem.alternatives` 与内置映射合并并做大小写不敏感去重（保留首次出现的大小写格式）。
2. **扩展模型结构（向后兼容）**：
   - `CatalogItem`（`src-tauri/src/github/models.rs`）和 `AppCore`（`src-tauri/src/models.rs`）分别添加：
     ```rust
     #[serde(default, skip_serializing_if = "Vec::is_empty")]
     pub alternatives: Vec<String>,
     ```
   - `CatalogItem::to_summary()` 调用 `resolved_alternatives(&self.alternatives, &self.id)` 填充 `core.alternatives`。
   - 同步更新全仓结构体字面量构造测试夹具（若有缺失 `alternatives` 字段处）。
3. **升级 `search_score` 分层打分（`catalog_feed_score.rs` & `catalog_service.rs`）**：
   - 在 `catalog_feed_score.rs` 定义：
     - `pub const SEARCH_SCORE_ALTERNATIVE_MATCH: i32 = 38;`
     - `pub const SEARCH_SCORE_DESCRIPTION_CONTAINS: i32 = 20;`
   - 在 `catalog_service.rs::search_score` 中按优先级匹配：
     1. Exact (`name` / `id` == q) → `100`
     2. Prefix (`name.starts_with(q)`) → `60`
     3. Name contains → `40`
     4. Alternative contains（遍历 `resolved_alternatives(&item.alternatives, &item.id)` 子串包含 `q`）→ `38`
     5. Alias contains → `35`
     6. Owner / Repo contains → `30`
     7. Description contains（仅当 `q.chars().count() >= 2` 时检查 `description` 与 `description_en`）→ `20`

## Acceptance Criteria

- [ ] 现存 `catalog.json` 不含 `alternatives` 字段时可无错反序列化并通过既有 `CatalogService` 单测。
- [ ] Rust 单测验证 `resolved_alternatives` 能正确合并显式字段与内置平替词并去重。
- [ ] Rust 单测验证搜索 `"TeamViewer"` 或 `"toDesk"` 时，`rustdesk/rustdesk` 以 `SEARCH_SCORE_ALTERNATIVE_MATCH` 命中并排在仅简介模糊命中的条目之前；单字符查询不触发简介误召回。
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
