# Issue 05: 本地推荐画像与隐私数据看板（`AffinityPrivacyRow` & 审计/重置接口）

Status: resolved
Blocked by: 02, 03

## 背景

为了向用户直观证明「所有画像计算与推荐重排 100% 在本地 SQLite 闭环完成、绝无任何云端上传」，并赋予用户对自身偏好画像的完全知情权与控制权，一期在设置页「数据管理与备份」（`DataManagementSection`）中新增**本地推荐与隐私数据看板（`AffinityPrivacyRow`）**。

## 目标

1. **设置白名单扩展**（`src-tauri/src/commands/settings.rs`、`src/types.ts`、`src/services/api.ts`）：
   - 在 `get_default_settings()` 中新增 `"enable_local_affinity" => "true"`；
   - 当 `save_setting` 修改 `enable_local_affinity` 时，调用 `crate::notify_affinity_updated()` 触发首页实时切换个性化推荐/默认基线排序。
2. **后端画像审计摘要与一键重置命令**（`src-tauri/src/commands/catalog_feed.rs` + `src-tauri/src/lib.rs`）：
   - 新增 `#[tauri::command] pub fn get_affinity_profile_summary(state: State<'_, AppState>) -> crate::AppResult<AffinityProfileSummary>`，返回：
     - `enabled: bool`
     - `starred_repo_count: usize`（来自 `user_repo_signals` 中 `starred` 与 `user_stars` 去重计数）
     - `forked_repo_count: usize`（来自 `user_repo_signals` 中 `forked`）
     - `owned_repo_count: usize`（来自 `user_repo_signals` 中 `owned`）
     - `favorites_count: usize`（来自 `user_favorites`）
     - `watched_count: usize`（来自 `watched_apps`）
     - `top_categories: Vec<AffinityCategoryStat>`（Top 3 偏好分类 ID 与归一化权重）
     - `top_languages: Vec<String>`（Top 3 仓库编程语言）
     - `last_synced_at: Option<i64>`（`affinity_github_synced_at` 时间戳）
   - 新增 `#[tauri::command] pub fn reset_affinity_profile(state: State<'_, AppState>) -> crate::AppResult<bool>`：
     - 清空 `user_repo_signals` 表与 `affinity_github_synced_at` 设置项，调用 `crate::notify_affinity_updated()` 通知首页恢复基线。
3. **前端 API 注册与 Demo Mock 对齐**（`src/services/api.ts`、`src/services/api/catalog.ts`、`src/services/api/demoMock.ts`）：
   - 在 `CMD` 中新增 `getAffinityProfileSummary: 'get_affinity_profile_summary'` 与 `resetAffinityProfile: 'reset_affinity_profile'`，确保 `cmdAlignment.test.ts` 与 `ipcArgsNaming.test.ts` 零报错。
4. **设置页隐私数据看板组件**（`src/components/AffinityPrivacyRow.tsx` + `src/views/SettingsView/sections/DataManagementSection.tsx`）：
   - 展示「本地隐私闭环（SQLite Only）」徽章与信号统计胶囊（GitHub Star/Fork 仓库数、应用内收藏/关注数、Top 3 偏好分类与语言、最近增量同步时间）；
   - 提供三个交互动作：
     - **个性化推荐开关**：一键开启/关闭首页动态推荐；
     - **立即增量同步**：触发 GitHub Star/Fork ETag 增量同步并刷新看板数据；
     - **清空本地画像**：调用 `resetAffinityProfile` 清空已拉取的 GitHub 仓库特征信号；
   - 补充中英文国际化文案（`src/i18n/locales/zh.json`、`src/i18n/locales/en.json`）。

## 范围（互斥）

- 允许修改：`src-tauri/src/commands/settings.rs`、`src-tauri/src/commands/catalog_feed.rs`、`src-tauri/src/lib.rs`、`src/services/api.ts`、`src/services/api/catalog.ts`、`src/services/api/demoMock.ts`、`src/components/AffinityPrivacyRow.tsx`（新建）、`src/views/SettingsView/sections/DataManagementSection.tsx`、`src/i18n/locales/zh.json`、`src/i18n/locales/en.json`。
- 禁止在 `src/views/*` 或 `src/components/*` 中直调 `@tauri-apps/api/*`。

## 验收标准

- [x] `src/services/api/cmdAlignment.test.ts`、`src/services/api/ipcArgsNaming.test.ts`、`src/views/noDirectInvoke.test.ts` 全部通过。
- [x] Rust 单测验证 `get_affinity_profile_summary` 正确汇总各来源信号计数与 Top 分类，`reset_affinity_profile` 清空后 `starred_repo_count` 与 `forked_repo_count` 归零。
- [x] 前端组件测试验证 `AffinityPrivacyRow` 可正常渲染信号统计、切换开关及触发清空操作。
