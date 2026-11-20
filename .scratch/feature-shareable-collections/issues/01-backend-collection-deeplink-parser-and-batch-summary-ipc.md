# Issue 01: 后端 `zstore://collection` 深链解析与 `resolve_collection_apps` 批量本地水合 IPC

Status: resolved
Blocked by: none

## Summary

扩展系统深链解析器以支持 `zstore://collection?...` 应用合集分享协议，执行严格长度/字符/规范坐标/上限门禁；并新增零网络纯本地批量水合命令 `resolve_collection_apps`，按顺序把合集内的仓库 ID 列表还原为可供预览和安装的 `AppSummary` 列表。

## Scope

- Allowed to modify:
  - `src-tauri/src/deeplink.rs`（`DeepLinkAction::Collection` 与 `DeepLinkParser::parse` 扩展及单测）
  - `src-tauri/src/commands/catalog_detail.rs`（新增 `resolve_collection_apps`）
  - `src-tauri/src/commands/mod.rs`（确认重导出）
  - `src-tauri/src/lib.rs`（注册 `commands::resolve_collection_apps`）
- Do not modify:
  - `src/` 前端代码（在 Issue 02 / 03 处理）
  - `src-tauri/src/installer/`（不改变安装及校验门禁）

## Implementation Details

1. **`DeepLinkAction::Collection` 与安全解析（`src-tauri/src/deeplink.rs`）**：
   - 常量：`const MAX_COLLECTION_APPS: usize = 30;`、`const MAX_COLLECTION_TITLE_CHARS: usize = 60;`、`const MAX_COLLECTION_NOTE_CHARS: usize = 140;`。
   - 在 `DeepLinkAction` 增加：
     ```rust
     Collection {
         title: String,
         note: Option<String>,
         app_ids: Vec<String>,
     }
     ```
   - 在 `DeepLinkParser::parse` 增加路由判定（须在 `zstore://{app_id}` 兜底分支之前，并将 `"collection"` 加入保留字拦截列表）：
     - 匹配 `path_part.eq_ignore_ascii_case("collection")`（query 中取 `ids`、`title`、`note`）以及 `collection/{ids}`（路径段取 `ids`，query 中取 `title`、`note`）；
     - 查询参数解析：`+` 转空格后走 `decode_payload`（命中 `\0` 返回 `None` 拒绝整条深链）；
     - `ids` 清洗：按 `,` 分割，逐项经 `crate::forge::canonical_app_id` 校验与小写归一化，使用 `HashSet` 保序去重，最多收集 `30` 个；若有效列表为空返回 `None`；
     - `title` / `note` 清洗：过滤 `char::is_control`，`trim()` 后按字符数分别截断至 `60` / `140` 字符（`note` 为空时返回 `None`）。
2. **`resolve_collection_apps` 批量水合命令（`src-tauri/src/commands/catalog_detail.rs`）**：
   - 签名：
     ```rust
     #[tauri::command(rename_all = "camelCase")]
     pub fn resolve_collection_apps(
         state: State<'_, AppState>,
         app_ids: Vec<String>,
     ) -> crate::AppResult<Vec<AppSummary>>
     ```
   - 执行步骤：
     1. 对入站 `app_ids` 逐项做 `crate::forge::canonical_app_id` 校验、去重与 `30` 上限截断；
     2. 在 `CatalogService` 查找合并目录命中项（远端精选 + 本地收录 overlay），保留原始先后顺序；
     3. 未命中目录的 ID 集合批量查 `db.get_repo_cards_batch(&miss_ids)` 与 `db.get_app_detail(id, None)` 回填，再经 `CatalogService::stamp_summary` 显式盖章 `is_cataloged = Some(false)`；
     4. 本地两层缓存均未命中的合法 ID，由 `crate::forge::RepositoryUrlParser::parse` 合成最小占位 `AppSummary`（含 `id`、`name`、`owner`、`repo`、`forge`、`forge_host`、`is_cataloged = Some(false)`、`platforms = vec![]`）；
     5. 对结果批量叠加 `resolve_confirmed_icon_from_db` 本地已确认图标。

## Acceptance Criteria

- [x] `deeplink.rs` 单测通过：覆盖标准与简写 `zstore://collection`、多 forge 坐标归一化（如 `codeberg:owner/repo`）、去重、30 条上限截断、非法坐标过滤、全无效 ID 返回 `None`、`%00` NUL 注入拒绝与 2048 长度拒绝。
- [x] `resolve_collection_apps` 单测通过：覆盖已收录应用、未收录仅命中 `repo_card_cache` 的应用、完全冷门占位坐标三种来源保序返回。
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
