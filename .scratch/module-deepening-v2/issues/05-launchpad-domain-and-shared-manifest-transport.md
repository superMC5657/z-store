# Issue 05: 前后端双向加深开源广场（`Launchpad`）领域模块并抽离共享无令牌清单同步传输

Status: resolved
Blocked by: 04, 06

## Summary

消除开源广场（`Launchpad`）在前后端两端的浅层切分与跨领域耦合：

1. **后端清单传输跨仓反向依赖与 952 行胖命令文件**：
   - `launchpad/mod.rs` 直接导入 `github::catalog_service::{MirrorPrimaryError, fetch_with_mirror_fallback}`，`commands/launchpad.rs` 借用 `state.catalog.http_client()`，且 `launchpad::fetch_once` 与 `catalog_service::fetch_catalog_once` 逐行重复无令牌 GET + `If-None-Match` + 429/5xx 可重试分类 + 体积上限读取；
   - `commands/launchpad.rs`（952 行）塞入了清单缓存读写、304 续期、`sync_launchpad_discussions_core`（含逐条查询 `db.get_launchpad_discussion_state` 的 **N+1 SQL 循环**）、`preflight_launchpad_submission` 多源探测，以及 4 个评论/顶帖/表情写命令手工调用 `github::discussions::rest_*_url` 删除匿名 REST `ETag Cache` 键。
2. **前端 `LaunchpadView` 与 `LaunchpadDiscussionModal` 11-prop 双端同步与重复状态机**：
   - 视图与讨论弹窗同时维护同一条目的 `discussion_upvotes`、`viewer_has_upvoted`、`discussion_comments_count`、`discussion_node_id`，靠 `mutationVerRef` 与 4 个手工回调防止后台脉冲覆盖乐观更新；
   - 顶帖动作在两处重复实现，849 行的 `LaunchpadDiscussionModal.tsx` 将请求序列、游标分页合并、`THUMBS_UP` 降级修补、匿名 REST 顶帖数夹紧与递归评论树状态机全部混写在 UI 渲染中。

## Scope

- Allowed to modify:
  - `src-tauri/src/forge/http.rs`（或 `src-tauri/src/mirror.rs`）
  - `src-tauri/src/github/catalog_service.rs`（仅切换至共享无令牌清单传输函数）
  - `src-tauri/src/github/discussions.rs`
  - `src-tauri/src/github/discussions_tests.rs`
  - `src-tauri/src/db/launchpad.rs`
  - `src-tauri/src/launchpad/mod.rs`
  - `src-tauri/src/launchpad/models.rs`
  - `src-tauri/src/launchpad/tests.rs`
  - `src-tauri/src/commands/launchpad.rs`
  - `src-tauri/src/commands/launchpad_tests.rs`
  - `src/views/LaunchpadView.tsx`
  - `src/views/LaunchpadView/LaunchpadDiscussionModal.tsx`
  - `src/views/LaunchpadView/useLaunchpadFeed.ts`（新增）
  - `src/views/LaunchpadView/useLaunchpadDiscussion.ts`（新增）
  - `src/views/LaunchpadView/*.test.tsx` & `src/views/LaunchpadView.test.tsx`
- Do not modify:
  - `src/demo/`（由 Issue 07 处理）
  - `src/App.tsx`（由 Issue 08 处理）

## Implementation Details

1. **抽离共享无令牌清单同步传输（后端 `forge/http.rs`）**：
   - 在 `forge/http.rs` 提供共享无令牌清单连接池（保持 D5 `PoolKind` 隔离，绝不携带认证 Token）与通用函数 `fetch_manifest_with_mirror_fallback(url, cached_etag, mirror_prefix, max_bytes, validate_mirror)`，统一处理首跳条件请求、`304 NotModified`、传输错误代理记账、429/5xx 镜像单次无条件重试与镜像载荷结构校验。
   - `CatalogService` 与 `launchpad` 共同调用该传输基础组件，彻底移除 `launchpad -> github::catalog_service` 导入与 `state.catalog.http_client()` 借用（落实 ADR-0029 §2.1 物理隔离）。
2. **深化后端 `src-tauri/src/launchpad/` 领域模块**：
   - 在 `db/launchpad.rs` 增加批量状态读取（或在批量写入后直接返回合并后的脉冲映射），消除 `sync_launchpad_discussions_core` 尾部的 N+1 `get_launchpad_discussion_state` 查询。
   - 在 `github/discussions.rs` 内聚匿名 REST `ETag Cache` 失效辅助（写操作成功后由讨论模块或 `launchpad` 领域方法内部统一失效对应主帖/评论 REST ETag，不再向 `commands/launchpad.rs` 泄漏 `pub fn rest_discussion_url` / `rest_comments_url`）。
   - 将清单加载与快照回退、脉冲同步（GraphQL 批量 + 匿名 REST 有界并发）、讨论读写写透及投稿只读预检全部收口至 `launchpad/` 领域接口；`commands/launchpad.rs` 精简为 ~120 行薄 IPC **adapter**。
3. **深化前端 `Launchpad` 状态与讨论树模块**：
   - 新增 `useLaunchpadFeed.ts`：统一持有广场清单状态、`mutationVer` 脉冲版本栅栏、后台 `syncLaunchpadDiscussions` 合并、一键 Star 与统一顶帖动作（供卡片与讨论弹窗共用同一顶帖入口），并提供单一 `patchDiscussionState` 写回口。
   - 新增 `useLaunchpadDiscussion.ts`：内聚主帖加载/强刷序列防竞态、评论游标续拉、匿名 REST 只读顶帖数不归零夹紧、评论/回复/表情反应/`THUMBS_UP` 降级树纯函数 reducer，并在加载/评论/顶帖后自动回调写回 `useLaunchpadFeed`，将 `LaunchpadDiscussionModal` 的同步入参从 11 个精简至核心上下文，组件本体只保留视图结构与焦点交互。

## Acceptance Criteria

- [ ] `src-tauri/src/launchpad/` 与 `src-tauri/src/commands/launchpad.rs` 不再引用 `github::catalog_service` 的 HTTP 客户端或镜像函数；`commands/launchpad.rs` 行数降至 180 行以内，且无 N+1 `get_launchpad_discussion_state` 循环。
- [ ] 后端单测基于 `Database::open_in_memory()` 覆盖 `launchpad` 清单 304/镜像回退、脉冲批量回读、评论/顶帖写透及 REST ETag 自动失效。
- [ ] 前端单测直接验证 `useLaunchpadFeed`（脉冲版本栅栏不覆盖乐观 Star/顶帖）与 `useLaunchpadDiscussion`（`THUMBS_UP` 反应降级、匿名 REST 顶帖数保留、二级回复合并），既有 `LaunchpadView*.test.tsx` 全绿。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`、`pnpm test` 与 `pnpm build` 全部通过。
