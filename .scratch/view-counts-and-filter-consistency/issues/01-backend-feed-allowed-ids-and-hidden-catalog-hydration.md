# Issue 01: 后端 Feed `allowedIds` 预过滤分页与隐藏目录批量水合补齐

Status: resolved
Blocked by: none

## Summary

修复分类子页、最新入库子页、收藏/关注及我的应用在后端分页与批量水合层的两处数据源缺口：

1. **`get_category_apps` 与 `get_latest_catalog_apps` 支持平台预过滤 `allowed_ids` 并回传全平台 `matched_ids`（`src-tauri/src/commands/catalog_feed.rs`）**：
   - 解决原先「先按全平台切每页 20 条，再在前端做平台交集」导致的 `total` 失真（恒为全平台总数）、首屏缺卡（甚至 0 卡）以及无法获知当前时间窗/分类在全部平台上的真实分布问题；
   - `allowed_ids: Option<Vec<String>>` 缺省 `None` 时行为保持 100% 向后兼容；传入 `Some(ids)`（含空数组 `Some(vec![])` 表示当前平台筛选为空）时，在分页前按小写规范 ID 过滤，确保返回的 `total`、`has_more` 与每页 `items`（满 20 条）严格对齐当前设备平台筛选；
   - `FeedPage` 新增可选响应字段 `matched_ids: Option<Vec<String>>`，携带该分类或该时间窗在 `allowed_ids` 过滤前的全部非隐藏规范 ID 列表，供前端零网络计算当前视图的侧栏平台分布与区分「分类/时间窗本身为空」vs「平台筛选为空」。
2. **`get_cached_app_details_batch` 补齐 `CatalogService` 回退（`src-tauri/src/commands/catalog_detail.rs`）**：
   - 当被 `is_hidden` 规则隐藏的精选收录应用或本地库应用未曾写入 `app_details` 缓存时，`cached_detail_summary(&db, raw)` 返回 `None`；补充回退查询 `state.catalog.get_catalog_item` 并叠加确认图标，确保收藏/关注/已装列表中的隐藏收录应用仍能获得完整富卡与真实 `platforms`。
3. **前端 API 封装与 Demo Mock 同步对齐**：
   - 严格遵循 `AGENTS.md` IPC 命名规范：前端请求键使用 camelCase `allowedIds`，后端响应字段使用 snake_case `matched_ids`，Demo Mock 仅读取 `a['allowedIds']`（禁 snake fallback）。

## Scope

- Allowed to modify:
  - `src-tauri/src/commands/catalog_feed.rs`
  - `src-tauri/src/commands/catalog_detail.rs`
  - `src/services/api.ts`
  - `src/services/api/catalog.ts`
  - `src/services/api/ipcArgsNaming.test.ts`
  - `src/demo/handlers/catalog.ts`
  - `src/demo/handlers/catalog.test.ts`
- Do not modify:
  - `src/views/*`（视图消费在 Issue 03 / 04 / 05 处理）
  - `src/App.tsx`, `src/app/*`（全局选择器在 Issue 02 处理）

## Implementation Details

### 1. `FeedPage`、`get_category_apps` 与 `get_latest_catalog_apps`（`src-tauri/src/commands/catalog_feed.rs`）

- 在 `FeedPage` 结构体增加可选字段（保持 `get_home_feed` 输出为 `None` 不冗余序列化）：
  ```rust
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub matched_ids: Option<Vec<String>>,
  ```
- 抽取纯辅助函数 `filter_by_allowed_ids(items: Vec<AppSummary>, allowed_ids: Option<&[String]>) -> Vec<AppSummary>`：
  - `None` → 原样返回 `items`；
  - `Some(ids)` → 将 `ids` 归一为小写 trim `HashSet<String>`（空串跳过；兼容 `canonical_app_id` 或小写 `id`），仅保留 `allowed_set.contains(&a.core.id.to_lowercase())` 的项并保持原排序。
- 在 `get_category_apps`（已有 `#[tauri::command(rename_all = "camelCase")]`）增加参数 `allowed_ids: Option<Vec<String>>`：
  1. 先按分类与 `!hidden_ids` 得到 `category_matched: Vec<AppSummary>`；
  2. 记录 `let matched_ids: Vec<String> = category_matched.iter().map(|a| a.core.id.clone()).collect();`；
  3. 执行 `let filtered = filter_by_allowed_ids(category_matched, allowed_ids.as_deref());`；
  4. 对 `filtered` 调用 `paginate_feed(&filtered, limit, offset)`，返回带 `matched_ids: Some(matched_ids)` 的 `FeedPage`。
- 在 `get_latest_catalog_apps`（已有 `#[tauri::command(rename_all = "camelCase")]`）增加参数 `allowed_ids: Option<Vec<String>>`：
  1. 先经 `rank_and_filter_latest_apps(visible, min_days, effective_max)` 得到时间窗全平台倒排结果 `window_ranked`；
  2. 记录 `let matched_ids: Vec<String> = window_ranked.iter().map(|a| a.core.id.clone()).collect();`；
  3. 执行 `let filtered = filter_by_allowed_ids(window_ranked, allowed_ids.as_deref());`；
  4. 对 `filtered` 分页并返回带 `matched_ids: Some(matched_ids)` 的 `FeedPage`。

### 2. `get_cached_app_details_batch` 收录回退（`src-tauri/src/commands/catalog_detail.rs`）

- 将单条映射逻辑提取为可单测的内部辅助函数 `resolve_cached_or_catalog_summary(db: &Database, catalog: &CatalogService, icons_dir: &Path, raw: &str) -> Option<AppSummary>`：
  - 若 `cached_detail_summary(db, raw)` 返回 `Some(mut summary)`：沿用现有 `catalog.get_catalog_item` 覆盖与 `catalog.stamp_summary(&mut summary)`；
  - 若返回 `None`：尝试 `catalog.get_catalog_item(raw)`，命中时通过 `catalog.item_to_stamped_summary(&cat_item)` 生成摘要，并调用 `confirmed_icon_for_id(db, catalog, icons_dir, &cat_item.id)` 叠加本地确认图标后返回 `Some(summary)`。

### 3. 前端类型、IPC 封装与 Demo Mock（`src/services/api.ts`, `src/services/api/catalog.ts`, `src/demo/handlers/catalog.ts`）

- `HomeFeedRaw` / `HomeFeedResult`（`src/services/api.ts`）新增可选字段 `matched_ids?: string[]`。
- `getCategoryApps(category, page?, perPage?, allowedIds?: readonly string[])` 与 `getLatestCatalogApps(windowOrSince?, page?, perPage?, allowedIds?: readonly string[])`（`src/services/api/catalog.ts`）：
  - 当 `allowedIds !== undefined` 时（含空数组 `[]`！注意：空数组表示平台全不选，必须原样传入 `args.allowedIds = [...allowedIds]`，不可用 `length > 0` 跳过），附加 camelCase 键 `allowedIds`；
  - 解析回包 `raw?.matched_ids`（若为字符串数组则透传 `matched_ids`）。
- `handleGetCategoryApps` 与 `handleGetLatestCatalogApps`（`src/demo/handlers/catalog.ts`）：
  - 先计算 `matched_ids = matched.map((s) => s.id)`；
  - 若 `Array.isArray(a['allowedIds'])`，按小写 `Set` 过滤 `matched` 后再计算分页 `items`、`total` 与 `has_more`，并回传 `matched_ids`；调用 `warnUnknownArgs` 锁定允许的 camelCase 键集。

## Acceptance Criteria

- [x] Rust 单元测试验证 `get_category_apps` / `get_latest_catalog_apps` 过滤与分页逻辑：
  - `allowed_ids = None` 时，`total` 与 `matched_ids.len()` 相等；
  - `allowed_ids = Some(vec![...])`（例如 30 条分类数据中仅 5 条散落在原第 1~2 页的项命中）时，第 1 页一次返回全部 5 条，`total == 5`、`has_more == false`，而 `matched_ids` 仍保留全部 30 个 ID；
  - `allowed_ids = Some(vec![])`（空平台选择）时，`items` 为空、`total == 0`、`has_more == false`，`matched_ids` 保留原非空列表。
- [x] Rust 单元测试验证 `resolve_cached_or_catalog_summary`：当 `app_details` 与 `repo_card_cache` 均无记录，但应用存在于 `CatalogService`（远端或本地库）时，返回带完整 `platforms`、`name`、`is_cataloged = Some(true)` 的摘要。
- [x] 前端测试（`catalog.test.ts` 与 `ipcArgsNaming.test.ts`）验证 `allowedIds`（含空数组 `[]`）正确传递且无非 camelCase 请求键。
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`、`npx tsc --noEmit` 通过。
