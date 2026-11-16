# Issue 03: 前端类型、IPC 表驱动对齐、`zstore://launchpad` 深链与 Demo Mock 实现

Status: done
Blocked by: 01, 02

## Summary

打通前后端 IPC 注册表、视图路由枚举、协议深链（`zstore://view/launchpad` 与 `zstore://launchpad/{app_id}`）以及官网在线演示 Demo Mock，使全套架构门禁测试（`cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`navigation.test.ts`、`useDeepLink.test.tsx`）100% 闭合。

## Scope

- Allowed to modify:
  - `src-tauri/src/lib.rs`（将 4 个 Launchpad 命令挂载进 `tauri::generate_handler![]`）
  - `src-tauri/src/deeplink.rs`
  - `src/types/index.ts`
  - `src/services/api/launchpad.ts`（新增）
  - `src/services/api.ts`
  - `src/services/api/ipcArgsNaming.test.ts`
  - `src/app/navigation.test.ts`
  - `src/app/hooks/useDeepLink.ts`
  - `src/app/hooks/useDeepLink.test.tsx`
  - `src/demo/handlers/launchpad.ts`（新增）
  - `src/demo/tauri-mock.ts`
  - `src/components/Sidebar.tsx`、`src/locales/zh-CN.json`、`src/locales/en-US.json`（仅最小补齐 `NAV_ITEM_META.launchpad` 与 `nav.items.launchpad` 以保证 `Record<ViewType, ...>` 编译与 `Sidebar.test.tsx` 通过；完整广场视图 UI 在 Issue 04 展开）
- Do not modify:
  - `src/views/FeaturedView.tsx`、`src/views/LatestView.tsx`、`src/views/TrendsView.tsx`

## Implementation Details

### 1. 视图枚举与协议深链扩展（`types/index.ts`、`deeplink.rs`、`useDeepLink.ts`）

- `VIEW_TYPES` 更新为：`['home', 'latest', 'categories', 'trends', 'launchpad', 'pending', 'favorites', 'installed', 'settings'] as const`；同步更新 `src/app/navigation.test.ts` 的 `unionMembers`。
- `src-tauri/src/deeplink.rs`：
  - 新增变体 `DeepLinkAction::LaunchpadApp { app_id: String }`；
  - 解析规则：
    - `zstore://launchpad` 或 `zstore://launchpad/` → `DeepLinkAction::OpenView { view: "launchpad".to_string() }`；
    - `zstore://launchpad/{app_id}` → 解码并经 `forge::canonical_lookup_id(&id)` 归一化后返回 `DeepLinkAction::LaunchpadApp { app_id }`；
    - 裸 ID 排除列表补充 `lower == "launchpad"`（单独 `zstore://launchpad` 已在上方命中 `OpenView`）。
- `src/types/index.ts` 中 `DeepLinkAction` 同步新增 `| { action: 'launchpad_app'; payload: { app_id: string } }`；
- `src/app/hooks/useDeepLink.ts`：收到 `launchpad_app` 时调用 `navigate('launchpad')`、触发可选回调 `onFocusLaunchpadApp?.(action.payload.app_id)` 并调用 `handleOpenDetail(action.payload.app_id)`（绝不触发安装确认态）。

### 2. 前端 API 封装与 IPC 命名守卫（`src/services/api/launchpad.ts` & `api.ts`）

- 在 `src/services/api.ts` 的 `CMD` 注册 4 项命令（与 `src-tauri/src/lib.rs` `generate_handler![]` 严格 1:1 对齐）：
  - `getLaunchpadFeed: 'get_launchpad_feed'`
  - `getLaunchpadDiscussion: 'get_launchpad_discussion'`
  - `addLaunchpadComment: 'add_launchpad_comment'`
  - `toggleLaunchpadUpvote: 'toggle_launchpad_upvote'`
- `src/services/api/launchpad.ts` 请求参数严格使用 `camelCase`：
  - `getLaunchpadFeed(forceRefresh = false)` → `{ forceRefresh }`
  - `getLaunchpadDiscussion(discussionRepo, discussionNumber, cursor?, forceRefresh = false)` → `{ discussionRepo, discussionNumber, ...(cursor ? { cursor } : {}), forceRefresh }`
  - `addLaunchpadComment({ discussionRepo, discussionNumber, discussionId, body, replyToId })`
  - `toggleLaunchpadUpvote({ discussionRepo, discussionNumber, subjectId, currentlyUpvoted })`
- 在 `src/services/api/ipcArgsNaming.test.ts` 中补充对 `launchpad.*` 全部 4 个包装器的调用断言与 `stubFor` 返回桩。

### 3. Live Demo Mock（`src/demo/handlers/launchpad.ts` & `src/demo/tauri-mock.ts`）

- 提供 3 条高质量 `spotlight` 演示项目 + 6 条 `items` 新品流演示项目（涵盖 GitHub 与 Codeberg 多托管源、中英文双语 `maker_note` / `maker_note_en`、平台组合与 `stars_7d_delta` 热度脉冲），并在内存维护可交互的 `+1` 顶帖计数与评论追加状态；
- 参数读取严格仅用 `camelCase` 并接入 `warnUnknownArgs`（严禁 snake_case fallback）。

## Acceptance Criteria

- [ ] Rust 单测验证 `DeepLinkParser::parse`：
  - `zstore://view/launchpad` 与 `zstore://launchpad` 返回 `OpenView { view: "launchpad" }`；
  - `zstore://launchpad/Acme/Hyper-Term` 归一返回 `LaunchpadApp { app_id: "acme/hyper-term" }`；
  - `zstore://launchpad/%00bad` 安全拒绝返回 `None`。
- [ ] 前端门禁单测 `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`navigation.test.ts`、`Sidebar.test.tsx`、`useDeepLink.test.tsx` 全部通过。
- [ ] `npx tsc --noEmit` 与 `npx vite build --config vite.demo.config.ts` 零错误通过。
