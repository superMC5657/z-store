# Feature Spec: 全栈深模块收敛与命令层去编排化二期（Module Deepening v2）

> 状态：Resolved（`01`–`09` 全部为 `resolved`）
> 关联契约：`CONTEXT.md`（领域词汇与架构原则 D1–D10）、`AGENTS.md`（IPC 命名约定与 `<CountBadge>` 规范）、`docs/agents/domain.md`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、ADR-0003/0004/0006/0007/0009/0010/0014/0015/0017/0018/0019/0020/0022/0025/0026/0027/0028/0029/0030。
> 设计方法：`codebase-design`（Deep Modules、Interface as Test Surface、Deletion Test、Two-Adapter Seam Discipline、Replace-Don't-Layer Testing）。

---

## 1. 问题诊断摘要

继 `#17 module-deepening` 清理单行透传壳与微型碎片文件后，随 Phase 5–8（`Repo Enrich Cache`、`Launchpad`、可分享合集、开源平替与相似推荐）演进，代码库浮现出更高阶的**命令层吞噬领域编排（Shallow Domain Modules + Fat IPC Adapters）**与**跨接缝状态漂移**：

1. **后端 `commands/*` 承担核心领域不变量编排，并形成跨命令循环依赖**：
   - **应用详情与轻量 Release 分叉（`AppDetail` & `ForgeProvider`）**：`commands/catalog_detail.rs`（2,220 行）与 `commands/updates_check.rs`（846 行）手工按 `ForgeType` 分支并重复编排 9 步 `ETag Cache` + `Cache TTL` 流程；非 GitHub `ForgeProvider` 详情拉取跳过 `Checksum Manifest`（导致 Codeberg/GitLab/Gitea `ReleaseAsset` 恒缺 `sha256` 触发无校验警告）且无 `ETag Cache` 与离线回退；`GitHubProvider` 缺失 D7 有限重试与 401 失效通知。
   - **四路 `AppSummary` 水合分裂与 `IconFetch` 世代反向依赖**：`catalog_search.rs`（2,622 行）、`catalog_detail.rs`、`history.rs`、`launchpad.rs` 各自维护不一致的卡片水合顺序；`catalog_search.rs` 与 `launchpad.rs` 互相引用 `LAUNCHPAD_ICON_GEN` 与 `emit_icon_job`，`launchpad.rs` 在持有 SQLite 互斥锁期间同步读盘解析 `Confirmed Icon`。
   - **目录与本地库双态失步（`Curated Catalog` & `Local Library`）**：`CatalogRepository`（101 行非测试代码）仅含 4 个单调用点薄透传与 1 个零调用死函数，`commands/catalog_custom.rs` 与 `commands/catalog_sync.rs` 被迫手工串联 SQLite、`CatalogService` 内存索引、`is_cataloged` 回填、`app_icon_cycles` 与 `purge_cataloged_repo_cards`（其中 `save_custom_app` 重存活跃本地库条目时漏调 `purge_cataloged_repo_cards`）。
   - **开源广场（`Launchpad`）命令膨胀与跨仓耦合**：`commands/launchpad.rs`（952 行）承载全部清单缓存、N+1 讨论脉冲回读与匿名 REST `ETag Cache` 手工删键，并反向借用 `CatalogService::http_client` 与 `fetch_with_mirror_fallback`。
   - **已安装应用（`InstalledApp`）命令环与 401 会话清理漂移**：`installer_query.rs ↔ updates_check.rs ↔ installer_uninstall.rs` 形成三向互调，6 个文件手工维护 `update_results` 失效；`lib.rs` 的 401 后台协程手写第二套会话清理，遗漏 `/user/` 前缀 `ETag Cache` 删除与 `clear_launchpad_viewer_upvotes`，且误清空 `github.com` 主机令牌回退。

2. **前端共享缓存双生实现、巨型有状态 Selector 与双 Adapter 契约漂移**：
   - **`Repo Enrich Cache` 与详情治愈扇出割裂**：`services/repoEnrichCache.ts` 的底层 M1 映射实际寄居在 `services/trends/enrich.ts`；`useDetailCacheSync.ts`（760 行）复制 4 遍占位简介治愈、派发 2 个 `window` 自定义事件并在 `trends/board.ts` 用 202 行 reducer 二次写回同一池；`Confirmed Icon` 的 L5 轮换解码在 5 个模块重复实现。
   - **`useAppSelectors` 非纯膨胀与跨 Hook Ref 桥接**：`selectors.ts`（1,214 行）接收 18 个入参、返回 33 个字段，内部暗藏异步水合、定时器与 8 个逐视图透传的平台计数回调；进入「我的应用」（`My Apps`）触发两次重复 `getInstalledApps()`；`StarredFeed.tsx` 内联 330 行分页 SWR 状态机，`useTrendBoard` 存在无效 `getSettings()` 挂载阻塞。
   - **`DemoStore` 散落全局状态与 `PendingView` 测试影子状态机**：`src/demo/` 状态散落在 7 个模块全局变量中，未合并 `Local Library` overlay 与 `Update Rule` 隐藏规则，点击本地库或 `Launchpad` 卡片详情直抛 `unknown app`；`PendingView.tsx` 为测试保留生产零调用的 `initialEntries` / `localEntries` 影子状态机，绕过真实 `tauriApi` 接缝。

---

## 2. 必须守住的真实接缝（Seam）与架构不变量

1. **前端唯一 IPC 接缝（Two Real Adapters）**：`src/services/api/client.ts` + `src/services/api.ts`（`CMD` 表驱动）连接 Tauri Rust 后端与 `src/demo/tauri-mock.ts` 两个真实 Adapter；所有请求键保持 camelCase、响应与事件字段保持 snake_case，受 `noDirectInvoke.test.ts`、`cmdAlignment.test.ts`、`ipcArgsNaming.test.ts` 与 `mockImportGraph.test.ts` 门禁保护。
2. **多源托管接缝 `ForgeProvider`（ADR-0006）**：保留 `ForgeProvider` trait 与 `ForgeRegistry`，为 GitHub、GitLab、Codeberg/Gitea 及单测 Mock Adapter 提供统一远端仓库与 Release 读取能力。
3. **核心契约不变**：严格保持 `CONTEXT.md` D1–D10、ADR-0004（流式 SHA-256 校验且 `Checksum Manifest` 绝不走镜像）、ADR-0007/0019（`Cache TTL` 与资产面手动触网边界）、ADR-0010（`Canonical App Id`）、ADR-0015（`IconFetch` 世代与 L1–L5 正交）、ADR-0017/0018（`Draft` / `Local Library` 与协议门禁）、ADR-0022（`My Apps` 口径）、ADR-0025（动态系统代理与连接池隔离）、ADR-0027（`repo_card_cache` 与三链路瘦索引）、ADR-0029（`Launchpad` 双仓物理隔离）与 `docs/count-display.md`（`<CountBadge>`）。

---

## 3. 依赖分类与测试策略（Replace, Don't Layer）

- **`in-process`**：前端 `Repo Enrich Cache` M1 池、`iconStore` 轮换准入、纯函数 `selectors`、`Bi-dimensional Filter`、`Launchpad` 脉冲版本门控——合并后直接通过深模块外部 **interface** 测试，删除针对旧内部事件或影子状态机的冗余测试。
- **`local-substitutable`**：后端 `CatalogService`、`CardHydrator`、`LaunchpadService`、`ManagedApps`、`oauth` 会话权威——统一以 `Database::open_in_memory()` 与临时目录直测深模块 **interface**，不在外部接口暴露内部表操作细节。
- **`ports & adapters` / `mock`**：后端 `ForgeProvider`、无令牌清单同步传输、`IconFetch` 事件接收端与前端 `DemoStore`——通过既有接缝注入测试 Adapter 验证端到端行为。

---

## 4. Issue 拆解与并行调度拓扑

| 编号 | 工单文件 | 对应审查候选 | 作用域摘要 | 状态 | 阻塞依赖 (`Blocked by`) |
| :---: | :--- | :---: | :--- | :---: | :---: |
| **01** | [`01-backend-catalog-overlay-authority.md`](./issues/01-backend-catalog-overlay-authority.md) | Candidate #4 | 删除 `CatalogRepository`，将 `Curated Catalog` 与 `Local Library` 事务、内存索引、图标槽及富卡清理收口至 `CatalogService` | `resolved` | `none` |
| **02** | [`02-backend-managed-apps-and-session-authority.md`](./issues/02-backend-managed-apps-and-session-authority.md) | Candidate #7 | 下沉 `InstalledApp` / `Update Rule` / `update_results` 生命周期至 `installer/`，统一 `oauth/` 登出与 401 失效清理 | `resolved` | `01` |
| **03** | [`03-backend-app-detail-and-forge-unification.md`](./issues/03-backend-app-detail-and-forge-unification.md) | Candidate #1 | 统一 `ForgeProvider` D7 重试与多源 `Checksum Manifest` 提取，将 `AppDetail` 与轻量 Release 决议收敛为单一深模块 | `resolved` | `01, 02` |
| **04** | [`04-backend-card-hydrator-and-iconfetch-lanes.md`](./issues/04-backend-card-hydrator-and-iconfetch-lanes.md) | Candidate #2 | 收敛单仓富卡批量水合与写透模块 `CardHydrator`，将四路 `IconFetch` 世代计数器与发射协调迁入 `icons/` | `resolved` | `03` |
| **05** | [`05-launchpad-domain-and-shared-manifest-transport.md`](./issues/05-launchpad-domain-and-shared-manifest-transport.md) | Candidate #5 | 抽离共享无令牌清单同步传输，前后端双向加深 `Launchpad` 领域模块并消除跨目录/跨弹窗泄漏 | `resolved` | `04, 06` |
| **06** | [`06-frontend-repo-enrich-heal-and-icon-cycle-admission.md`](./issues/06-frontend-repo-enrich-heal-and-icon-cycle-admission.md) | Candidate #3 | 归位前端 `Repo Enrich Cache` M1 存储与订阅扇出，废除 `window` 治愈事件双跳，统一 `iconStore` L5 轮换准入 | `resolved` | `none` |
| **07** | [`07-frontend-demo-store-and-pending-seam-cleanup.md`](./issues/07-frontend-demo-store-and-pending-seam-cleanup.md) | Candidate #8 | 收敛 `DemoStore` 补齐 `Local Library` / `Launchpad` 详情与隐藏规则，移除 `PendingView` 测试影子状态机 | `resolved` | `06` |
| **08** | [`08-frontend-app-shell-selectors-and-richcard-swr-hooks.md`](./issues/08-frontend-app-shell-selectors-and-richcard-swr-hooks.md) | Candidate #6 | 纯化 `selectors.ts`，下沉 `usePlatformFilter` 与 `useMyAppsState`，提取 `useStarredFeed` 与 `useTrendSession` | `resolved` | `05, 07` |
| **09** | [`09-docs-context-and-full-regression-gates.md`](./issues/09-docs-context-and-full-regression-gates.md) | 全局收口 | 同步 `CONTEXT.md`、关联 ADR 实现索引与 `.scratch/README.md`，执行全栈回归与构建门禁 | `resolved` | `05, 08` |

### 并行执行波次（零文件冲突）

- **Wave 1（立即可并行）**：`01`（Rust 目录权威加深） ∥ `06`（前端富卡池与图标轮换准入加深）
- **Wave 2（跨端可并行）**：`02`（Rust 已装应用与会话权威） ∥ `07`（前端 `DemoStore` 与待收录接缝收敛）
- **Wave 3**：`03`（Rust `AppDetail` 与 `ForgeProvider` 统一决议）
- **Wave 4**：`04`（Rust `CardHydrator` 与 `icons/` 世代流协调）
- **Wave 5**：`05`（跨端 `Launchpad` 深模块与共享清单同步传输）
- **Wave 6**：`08`（前端 `App` 状态域、纯 `selectors` 与列表 SWR Hook 收敛）
- **Wave 7**：`09`（文档对齐与全仓门禁验收）

---

## 5. 全仓验收门禁

每张工单完成时须通过对应端门禁，最终在 `09` 通过全套门禁：

- **Rust 后端**：`cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- **前端与 Demo**：`pnpm test`（含 `noDirectInvoke.test.ts`、`cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`mockImportGraph.test.ts`、`countDisplay.test.ts`、`components.i18n.scan.test.ts`）与 `pnpm build`
