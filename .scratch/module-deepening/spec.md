# Feature Spec: 全仓模块合并加深（Module Deepening & De-fragmentation）

> 状态：Phase 1–3 已完成（`01`–`08` 为 `done`，`09` 为 `needs-triage`）
> 关联契约：`CONTEXT.md`（领域词汇与架构原则 D1–D10）、`docs/agents/domain.md`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、ADR-0004/0005/0006/0007/0010/0014/0015/0017/0018/0021。
> 设计方法：`codebase-design`（Deep Modules、Interface as Test Surface、Deletion Test、One-vs-Two Adapter Seam Discipline、Replace-Don't-Layer Testing）。

---

## 1. 问题背景与诊断摘要

基于 `codebase-design` 对 `src-tauri/src/`（Rust 后端）与 `src/`（React 19 + TypeScript 前端）进行全仓扫描，发现当前代码库经历多轮特性迭代与局部拆分后，存在两类典型的结构性浅化（Shallow Modules）与过度碎片化问题：

1. **纯透传壳与微文件泛滥（Deletion Test 下零复杂度留存）**
   - **后端**：`commands/installer.rs`（43 行）5 个命令全量一行转发至同层子文件；`commands/catalog.rs`、`commands/updates.rs`、`github/readme_variants.rs`、`installer/downloader.rs` 仅含 4–16 行 `#[path]` 重导出；`InstallerEngine` 为零字段单元结构体静态透传壳；`scanner/join.rs` 有效逻辑仅 34 行，包装 `matcher` 与 `canonical_lookup_id` 并迫使 `commands/scanner.rs` 自行编排；`oauth/` 700 行代码拆成 6 个文件；`userdata/` 只有单函数 `parse_import_payload`。
   - **前端**：`services/api/zlog.ts`（12 行）、`services/appProcess.ts`（13 行）、`services/custom/status.ts`（11 行）、`services/custom/iconUrl.ts`（13 行）、`lib/manualOnly.ts`（13 行）、`utils/notify.ts`（11 行）、`utils/fallbackOpener.ts`（24 行）、`views/useViewFilter.ts`（19 行，非 Hook）、`views/pending/pendingText.ts`（10 行）、`views/pending/pendingStyles.ts`（31 行）、`components/AppDetailModal/openExternal.ts`（9 行）、`views/SettingsView/SettingsSection.tsx`（19 行）、`components/hostEnv.ts`（28 行）等大量单函数/单常量/超薄壳文件；`submitPrefillFlow.ts::openPrefillPage` 重复实现 `tauriApi.openUrl` 已有的 `resolveFallbackOpener()` 兜底。

2. **机械切片导致的“大接口浅模块（Large Interface）”与跨层错位**
   - **后端图标子系统**：`IconFetch` / `Confirmed Icon` / `AppIconCycle` 的探测、状态机、磁盘缓存与 LRU 横跨 `github/`、`db/icon_cycle.rs`、`commands/icons*.rs`、`commands/catalog_search.rs` 共 3 个顶层目录、7+ 个文件，并在 `commands/icons.rs` 与 `commands/icons_cycle_probe.rs` 中形成多层薄委托转发。
   - **前端草稿域与 IPC 门面错位**：`services/custom/` 被拆为 5 个微小文件，却反向从 IPC 客户端 `services/api/catalog.ts` 导入 360 行草稿启发式构造逻辑；`app/selectors.ts` 仅重导出 `isCollectedStatus`。
   - **前端趋势榜假收口**：`services/trends/board.ts`（1368 行）对抓取仅包了一层纯转发 `fetchTrendsResultSeam`，却向 `useTrendEnrichment.ts` 暴露了 **26 个**微步骤 helper 接口；同时 `useTrendBoard.ts` / `TrendsView.tsx` 仍绕开 `board.ts` 直调 `boards.ts`、`parse.ts`、`enrich.ts`。
   - **前端 `App.tsx` 机械拆 Hook**：`useAppSubscriptions`（27 个入参）、`useUpdateActions`（10 个入参、无私有状态）、`usePlatformBackfill`（9 个入参）把 4 个重叠列表状态（`apps` / `onlineApps` / `recentlyViewedApps` / `uncatalogedExtraApps`）的 setter 与 ref 暴露在接口上，未形成真正的数据局部性（Locality）。

---

## 2. 架构边界与不变量约束（不得破坏的真实 Seam）

按 `codebase-design` “至少两个真实 Adapter 才保留 Seam” 原则及本仓门禁测试，以下边界**显式保留**，重构不得破坏：

1. **前端 IPC 唯一出口与 Demo Mock Seam**：`src/services/api/client.ts`（唯一裸 `invoke` 出口）+ `src/services/api.ts`（表驱动 `CMD` 与 `tauriApi`），对应生产 Tauri IPC 与 `src/demo/tauri-mock.ts` 两个真实 Adapter，并受 `src/views/noDirectInvoke.test.ts` 与 `src/services/api/cmdAlignment.test.ts` 强制门禁约束。
2. **多源托管抽象 `ForgeProvider`**：`src-tauri/src/forge/` 存在 GitHub / GitLab / Codeberg / Gitea 多个真实远端 Adapter，保持 trait 与 `ForgeRegistry` Seam。
3. **协议与不变量**：`CONTEXT.md` 中的 D1–D10、ADR-0004（SHA-256 校验）、ADR-0007（Cache TTL 挡位与更新检查豁免）、ADR-0010（`Canonical App Id`）、ADR-0014（趋势 L2 治理）、ADR-0015（`IconFetch` level 纯 L + `via` 正交）、ADR-0017（`Draft` / `Local Library` overlay）、ADR-0018（可配开源协议门禁）均保持语义完全不变。

---

## 3. 依赖分类与测试策略（Replace, Don't Layer）

按 `codebase-design/DEEPENING.md` 划分依赖类别并执行替换式测试：
- **In-process（纯计算/内存状态）**：`Draft` 校验/合成、趋势榜缓存/合并、平台筛选、Toast 总线、视图文案/样式、状态机规则——直接合并，通过加深后模块的新 Interface 直接单测；旧微文件的破碎单测随文件删除一并移除或替换为 Interface 级测试。
- **Local-substitutable（SQLite 内存库 / 临时文件系统）**：`scanner`、`userdata` 导入、`db`、`icons` 磁盘缓存、`commands` 集成行为——使用 `Database::open_in_memory()` 与 `std::env::temp_dir()` 在测试套件内直测加深后模块 Interface，不在外部接口暴露内部 Seam。
- **True external（GitHub / Forge HTTP / Tauri Shell）**：HTTP 客户端注入或保留 `api_base` / `ForgeProvider` / `tauriInvoke` Adapter Seam，测试以 Mock Adapter 驱动。

---

## 4. 实施 Issue 清单与调度图

### Issue 清单

| 编号 | 票文件 | 作用域 | 状态 | 阻塞依赖 |
|---|---|---|---|---|
| 01 | [`01-backend-passthrough-and-shell-cleanup.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/01-backend-passthrough-and-shell-cleanup.md) | 后端纯透传壳、`#[path]` 空壳、`InstallerEngine`、`developer_endpoints` | `done` | `none` |
| 02 | [`02-backend-scanner-join-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/02-backend-scanner-join-deepening.md) | 后端 `scanner/join.rs` 合并加深进 `AppScanner` | `done` | `none` |
| 03 | [`03-backend-oauth-and-userdata-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/03-backend-oauth-and-userdata-deepening.md) | 后端 `oauth/` 收敛与 `userdata/` 备份导入流程下沉 | `done` | `none` |
| 04 | [`04-backend-db-and-icons-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/04-backend-db-and-icons-deepening.md) | 后端 `Confirmed Icon` / `IconFetch` / `AppIconCycle` 深模块收敛与 `db/` 小表整并 | `done` | `01` |
| 05 | [`05-frontend-custom-draft-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/05-frontend-custom-draft-deepening.md) | 前端 `services/custom/` 合并与 `api/catalog.ts` 草稿启发式归位 | `done` | `none` |
| 06 | [`06-frontend-trends-board-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/06-frontend-trends-board-deepening.md) | 前端 `services/trends/` 真正收口与 `useTrendEnrichment` 瘦身 | `done` | `05` |
| 07 | [`07-frontend-ipc-and-desktop-bridge-cleanup.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/07-frontend-ipc-and-desktop-bridge-cleanup.md) | 前端 `api/zlog`、`appProcess`、`fallbackOpener` 与重复 `openUrl` 兜底清理 | `done` | `05` |
| 08 | [`08-frontend-leaf-microfiles-consolidation.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/08-frontend-leaf-microfiles-consolidation.md) | 前端单函数/单常量/超薄 UI 碎片文件汇总合并（含 `platformStorage` / `notify` / `pending*` 等） | `done` | `07` |
| 09 | [`09-frontend-app-state-store-deepening.md`](file:///z:/rust_workplace/z-store/.scratch/module-deepening/issues/09-frontend-app-state-store-deepening.md) | 前端 `App.tsx` 与大接口浅 Hook（`useAppSubscriptions`/`useUpdateActions`/`usePlatformBackfill`）状态域收敛 | `needs-triage` | `05, 06, 08` |

### 并行阶段拓扑

- **Phase 1（无文件冲突，可全并行）**：`01`、`02`、`03`、`05`
- **Phase 2（跨端并行）**：`04`（依赖 `01`） + `06`（依赖 `05`） + `07`（依赖 `05`）
- **Phase 3**：`08`（依赖 `07`）
- **Phase 4（需维护者确认）**：`09`（依赖 `05, 06, 08`）

---

## 5. 全仓验收门禁

每项 Issue 落地后必须通过：
- 后端：`cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- 前端：`pnpm test`（覆盖 `vitest` 全量测试，含 `noDirectInvoke.test.ts`、`cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`components.i18n.scan.test.ts`）与 `pnpm build`（含 `tsc` 类型检查）
