# Issue 05: 「少推这类」原子双写持久化与前后端/演示站 IPC 对齐

Status: resolved
Blocked by: 04

## 背景

用户在精选页某张推荐卡片菜单上点击「少推 {分类}」（`scope = 'category'`）时，前端 `useFeaturedPage.ts` 当场将该卡片加入 `dismissedIds` 淡出隐藏，但后端 `dismiss_featured` 原先只写入了 `(category, 'category')` 单行。若该分类降权后在极端单类画像下仍被兜底选中，刚点过负反馈的那张卡片会在下次进入页面时重新出现。

## 目标

1. **后端命令与数据库原子双写**：
   - 在 `src-tauri/src/db/affinity.rs` 新增 `pub fn upsert_category_and_app_feedback(&self, category: &str, app_id: Option<&str>, now: i64) -> Result<()>`：在 `with_immediate_transaction` 中写入 `(category, FeedbackScope::Category, now)`，并在 `app_id` 非空时一并写入 `(app_id, FeedbackScope::App, now)`，完成后调用一次 `crate::notify_affinity_updated()`；
   - 更新 `src-tauri/src/commands/catalog_feed.rs::dismiss_featured`：添加 `#[tauri::command(rename_all = "camelCase")]` 宏属性，扩展参数 `app_id: Option<String>`；当 `parsed == FeedbackScope::Category` 时，若 `app_id` 非空则经 `crate::forge::canonical_app_id` 校验归一化后调用上述双写方法（`app_id` 为 `None` 或空串时仅写分类反馈，保持向后兼容）。
2. **前端 API、视图 Hook 与演示站 Mock 对齐（严格遵守 AGENTS.md IPC camelCase 规则）**：
   - `src/services/api/catalog.ts::dismissFeatured(target: string, scope: FeedbackScope, appId?: string)`：当 `appId` 传入非空字符串时，在请求载荷中附带 camelCase 键 `appId`；
   - `src/views/FeaturedView/useFeaturedPage.ts::dismiss`：当 `scope === 'category'` 时调用 `tauriApi.dismissFeatured(category, 'category', appId)`；
   - `src/demo/handlers/featured.ts`：
     - `handleDismissFeatured` 的 `warnUnknownArgs` 扩展为 `['target', 'scope', 'appId']`（严禁 snake_case 回退）；
     - 演示站内存态新增 `dismissedCategories = new Set<string>()`；`scope === 'category'` 时将 `target` 加入 `dismissedCategories`，并将可选 `appId` 加入 `dismissed`；`handleClearFeedFeedback` 同步清空两者并返回合并条数；`handleGetFeaturedPage` 在 `category_pick` 与 `explore` 中跳过 `dismissedCategories`。
3. **测试门禁补充**：
   - `src/services/api/ipcArgsNaming.test.ts`：补充调用 `catalog.dismissFeatured('dev', 'category', 'o/r')`，断言请求键符合 `/^[a-z][a-zA-Z0-9]*$/`；
   - `src/views/FeaturedView.test.tsx`：验证点击卡片菜单「少推这类」时，`tauriApi.dismissFeatured` 收到 `(category, 'category', app.id)`。

## 范围（互斥）

- 允许修改：`src-tauri/src/db/affinity.rs`、`src-tauri/src/commands/catalog_feed.rs`、`src/services/api/catalog.ts`、`src/views/FeaturedView/useFeaturedPage.ts`、`src/demo/handlers/featured.ts`、`src/services/api/ipcArgsNaming.test.ts`、`src/views/FeaturedView.test.tsx`。
- 禁止触碰：`src-tauri/src/github/affinity.rs`、`src-tauri/src/github/featured.rs`、`src/views/CategoriesView.tsx`。

## 验收标准

- [ ] 后端单测：`dismiss_featured`（或底层 DAO）在 `scope = "category"` 且附带 `app_id` 时，同时产生 `Category` 与 `App` 两条有效反馈；`app_id` 缺省时仅产生 `Category` 反馈。
- [ ] 前端单测：`FeaturedView.test.tsx` 与 `ipcArgsNaming.test.ts` 全绿，所有 IPC 参数键严格 camelCase。
- [ ] 演示站单测或交互：触发分类负反馈后重拉 `handleGetFeaturedPage`，该分类与触发卡片均被过滤。
- [ ] `pnpm test` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。

## Comments

- 演示站 mock 与后端对齐：hero 先在未被少推的分类里取满、凑不满才补位；`fresh` 也跳过被少推的分类。issue 只要求 `category_pick` 与 `explore`，此处为保持演示站与后端同口径。
