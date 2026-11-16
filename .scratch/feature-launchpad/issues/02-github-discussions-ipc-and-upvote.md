# Issue 02: GitHub Discussions 混合读取、应用内评论与 `+1` 顶帖 IPC 实现

Status: done
Blocked by: 01

## Summary

实现开源广场社区互动后端核心模块（`src-tauri/src/github/discussions.rs` 及对应命令），在不改动现行 OAuth 授权范围（`OAUTH_SCOPE = "public_repo user"`）的前提下，打通应用内查看讨论、发表评论/回复及投 `+1` 顶帖闭环，并为未登录用户提供免报错的匿名只读降级路径。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/discussions.rs`（新增）
  - `src-tauri/src/github/mod.rs`
  - `src-tauri/src/launchpad/models.rs`
  - `src-tauri/src/commands/launchpad.rs`
  - `src-tauri/src/commands/mod.rs`
- Do not modify:
  - `src-tauri/src/oauth/mod.rs` 中的 `OAUTH_SCOPE`（保持 `"public_repo user"`，存量登录用户零重授权）
  - `src/` 前端代码（在 Issue 03/05 接入）

## Implementation Details

### 1. 仓库坐标校验与 GraphQL 安全规范（`github/discussions.rs`）

- 严格校验 `discussion_repo`：复用 `oauth::split_github_repo_id` 校验为合法双段 `owner/repo`（拒绝含 `/`、`?`、`#`、`..`、`:` 或控制字符的输入，防路径穿越与 SSRF），`discussion_number > 0`。
- 所有 GraphQL 请求统一 POST `https://api.github.com/graphql`，复用 `shared_http_client()` 与 `oauth::star::auth_headers`（`Bearer` 令牌永不写入日志），请求体严格使用 GraphQL `variables` JSON 参数化绑定（`$owner`, `$repo`, `$number`, `$cursor`, `$discussionId`, `$body`, `$replyToId`, `$subjectId`），**严禁字符串拼接 GraphQL 查询体**。
- 每次响应调用 `crate::notify_rate_limit("github.com", resp.headers())`；HTTP `401` 统一走 `crate::check_auth_expired(401, ctx)` 触发重登通知。

### 2. 三条核心命令契约（`commands/launchpad.rs`）

1. **`get_launchpad_discussion(state, discussion_repo, discussion_number, cursor, force_refresh) -> AppResult<LaunchpadDiscussionDetail>`**
   - **已认证主路径（`state.active_github_token()` 非空）**：
     - GraphQL 查询 `repository(owner: $owner, name: $repo) { discussion(number: $number) { ... } }`：
       - 提取主帖 `id`、`number`、`title`、`body`、`url`、`createdAt`、`locked`、`closed`、`category { name }`、`author { login avatarUrl url }`；
       - 提取顶帖与点赞状态：`upvoteCount`、`viewerCanUpvote`、`viewerHasUpvoted` 以及 `reactionGroups` 中 `content == "THUMBS_UP"` 的 `viewerHasReacted` 与 `reactors.totalCount`；当 `viewerCanUpvote == false` 时，以 `THUMBS_UP` Reaction 计数与状态作为展示口径；
       - 提取评论列表 `comments(first: 30, after: $cursor)`：`totalCount`、`pageInfo { hasNextPage endCursor }`、每条评论的 `id`、`body`、`createdAt`、`authorAssociation`、`author`、`upvoteCount`、`viewerHasUpvoted` 及前 20 条二级 `replies`。
   - **未认证降级路径（无活跃 Token）**：
     - 避免直接调 GraphQL 触发硬性 401：仅在 `cursor.is_none()` 时，经 `github::http::get_with_etag`（`force_refresh == Some(true)` 时跳过读缓存）请求 `https://api.github.com/repos/{owner}/{repo}/discussions/{number}` 与 `/comments?per_page=30`；
     - 成功时组装只读 `LaunchpadDiscussionDetail`（`viewer_can_comment = false`、`viewer_can_upvote = false`、`auth_required_for_write = true`）；若遭遇 403 限流或网络异常，优先回退 `api_etag_cache` 旧载荷（`is_stale = true`），仍无缓存则返回结构化降级空壳（携带确定性 `url: https://github.com/{owner}/{repo}/discussions/{number}` 与 `auth_required_for_write = true`），前端可直接引导登录或跳浏览器查看，不弹红字错误。

2. **`add_launchpad_comment(state, discussion_repo, discussion_number, discussion_id, body, reply_to_id) -> AppResult<LaunchpadDiscussionComment>`**
   - 要求持有活跃 GitHub Token（缺失时返回 `"请先登录 GitHub 账号后再发表评论"`）；
   - 校验 `body.trim()` 非空且字符数 `<= 10_000`；
   - 若 `discussion_id` 未传或为空，先以轻量 GraphQL 查询 `(owner, repo, number)` 解析 `discussion.id`（同时检查 `locked` 状态，已锁帖返回明确提示）；
   - 执行 `addDiscussionComment(input: { discussionId, body, replyToId })`；成功后清理本地 `api_etag_cache` 中对应匿名 `/discussions/{number}/comments` 缓存键，确保状态一致。

3. **`toggle_launchpad_upvote(state, discussion_repo, discussion_number, subject_id, currently_upvoted) -> AppResult<LaunchpadUpvoteResult>`**
   - 要求持有活跃 GitHub Token（缺失时返回 `"请先登录 GitHub 账号后再顶帖"`）；
   - 若 `subject_id` 已传入（来自 `launchpad.json` 的 `discussion_node_id` 或已加载讨论详情），直接发起单次 GraphQL Mutation；否则先查询节点 `id` 与 `viewerCanUpvote`；
   - **双模顶帖容错**：
     - 首选调用 `addUpvote`（当 `!currently_upvoted`）或 `removeUpvote`（当 `currently_upvoted`），返回 `mode: "upvote"` 及最新 `upvote_count`、`viewer_has_upvoted`；
     - 若 GraphQL 返回 `FORBIDDEN` / `"Resource not accessible by integration"` 或预检 `viewerCanUpvote == false`，自动回退执行 `addReaction(content: THUMBS_UP)` / `removeReaction(content: THUMBS_UP)`，返回 `mode: "reaction"` 及更新后的 `+1` 计数与状态。

## Acceptance Criteria

- [ ] Rust 单测覆盖 `discussion_repo` 非法坐标拦截（空串、单段、含路径遍历 `..`、非 GitHub `codeberg:a/b` 前缀）。
- [ ] Rust 单测覆盖 GraphQL 响应解析器（正常主帖+二级回复、已锁帖 `locked == true`、`INSUFFICIENT_SCOPES` 错误映射、`addUpvote` `FORBIDDEN` 时触发 `THUMBS_UP` Reaction 回退解析）。
- [ ] Rust 单测覆盖匿名 REST JSON 解析与限流降级行为（`auth_required_for_write == true`，`url` 拼接正确）。
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部零警告通过。
