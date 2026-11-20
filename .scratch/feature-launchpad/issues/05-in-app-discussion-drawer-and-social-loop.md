# Issue 05: 应用内 GitHub Discussion 评论/顶帖抽屉与未登录优雅降级闭环

Status: done
Blocked by: 04

## Summary

构建开源广场内置的社区讨论与顶帖抽屉组件（`LaunchpadDiscussionDrawer`），实现客户端内闭环阅读新品讨论帖、投 `+1` 顶帖、发表评论与二级回复、点击评论者头像查看开发者画像，并在未登录或授权过期时提供平滑的只读浏览与一键去登录引导。

## Scope

- Allowed to modify:
  - `src/views/LaunchpadView/LaunchpadDiscussionDrawer.tsx`（新增）
  - `src/views/LaunchpadView/LaunchpadDiscussionDrawer.test.tsx`（新增）
  - `src/views/LaunchpadView.tsx`
  - `src/styles/components-launchpad.css`
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/components/components.i18n.scan.test.ts`（将 `LaunchpadDiscussionDrawer.tsx` 加入 `MIGRATED_FILES`）
- Do not modify:
  - `src/utils/sanitize.ts`（直接复用现有 `sanitizeHtml` 安全白名单，不放宽任何安全规则）

## Implementation Details

### 1. 抽屉结构与无障碍交互（`LaunchpadDiscussionDrawer.tsx`）

- 采用右侧滑出抽屉 / 模态面板（`role="dialog"`, `aria-modal="true"`, `aria-labelledby`，支持背景遮罩点击与 `Escape` 键关闭，打开时管理焦点）。
- **头部区域**：
  - 展示关联应用图标、名称、自荐语摘要，以及右上角「在 GitHub 打开」（`tauriApi.openUrl(detail.url || entry.discussion_url)`）与关闭按钮；
  - 醒目单色 `+1 顶帖` 切换按钮（展示实时 `upvote_count` 与 `viewer_has_upvoted` 高亮态）：
    - 已登录点击：调用 `tauriApi.toggleLaunchpadUpvote`，防连点节流，成功后同步回写父视图 `LaunchpadView` 对应卡片的 `discussion_upvotes` 与顶帖状态；
    - 未登录 / `oauthUser.is_expired` 点击：不发写请求，Toast 提示或高亮底部「登录 GitHub 参与顶帖与评论」引导条。

### 2. Markdown 净化渲染、二级回复与头像联动

- 主帖正文与每条评论/二级回复正文经 `marked.parse` 转 HTML 后，**强制经 `sanitizeHtml` 净化**再渲染；拦截内部 `<a>` 点击统一交由 `tauriApi.openUrl` 打开外部浏览器，阻断 WebView 页面跳转。
- 评论列表：
  - 每条评论渲染 `<CachedAvatar src={comment.author.avatar_url} login={comment.author.login} size={24} />`、`@{comment.author.login}`、作者身份标签（如项目作者 `entry.owner === comment.author.login` 挂载 `.status-tag` `作者` / `Maker`）、相对时间与「回复」按钮；
  - 点击评论者头像或用户名关闭或叠层打开 `DeveloperProfileModal(comment.author.login)`；
  - 支持游标分页：当 `detail.has_next_page && detail.end_cursor` 为真时，列表底部展示「加载更多评论」按钮，调用 `getLaunchpadDiscussion(..., endCursor)` 追加合并去重。

### 3. 评论/回复编辑器与未登录降级态

- **已登录且 `!detail.locked`**：
  - 底部固定多行输入框（支持选中某条一级评论显示「正在回复 @xxx × 取消」标签，携带 `replyToId = comment.id`；`Ctrl+Enter` / `Cmd+Enter` 快捷发送）；
  - 发送成功后就地将新评论插入列表（一级评论追加末尾、二级回复插入目标评论 `replies`），清空输入框，并同步使父卡片 `discussion_comments_count + 1`。
- **锁帖态（`detail.locked`）**：隐藏输入框，展示中性提示「该讨论已被维护者锁定，仅支持浏览」。
- **未登录或凭据过期态（`!oauthUser || oauthUser.is_expired || detail.auth_required_for_write`）**：
  - 正常渲染后端匿名通道返回的只读主帖与评论列表（若匿名 API 因限流仅返回空壳，则展示引导前往浏览器阅读全文链接）；
  - 底部编辑器位置替换为紧凑登录引导栏：说明「登录 GitHub 即可在应用内直接评论与 +1 顶帖」，附「前往登录」按钮（点击关闭抽屉并跳至设置页 `#settings-account`）与「在 GitHub 网页参与」次级按钮。

## Acceptance Criteria

- [x] 单测（`LaunchpadDiscussionDrawer.test.tsx`）验证：
  - 打开抽屉正确加载主帖、评论与二级回复，包含 `<script>alert(1)</script>` 或 `onerror=` 的恶意评论 Markdown 被 `sanitizeHtml` 完全剥离；
  - 项目作者本人的评论正确显示单色 `作者` / `Maker` `.status-tag`；
  - 已登录态下点击 `+1` 顶帖调用 `toggleLaunchpadUpvote` 并同步更新父级计数；提交一级评论与二级回复（带 `replyToId`）调用 `addLaunchpadComment` 并就地上屏；
  - 未登录态下不渲染可提交文本框，展示「前往登录」与「在 GitHub 打开」降级入口，点击「前往登录」触发账号设置导航；
  - 按下 `Escape` 正常关闭抽屉。
- [x] `noDirectInvoke.test.ts`、`countDisplay.test.ts`、`components.i18n.scan.test.ts`、`npx vitest run` 全部通过。
