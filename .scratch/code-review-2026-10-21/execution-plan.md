# 修复执行计划（38 张工单 → 13 个可粘贴批次）

用法：每批开一个**新会话**，把该批的代码块整段粘贴进去即可。批次必须**按编号顺序**执行（依赖与文件重叠关系见下），不要并行开多个会话改同一分支。

## 分支策略（只切一次）

全程使用**单一长分支** `fix/code-review-2026-10-21`，从 `dev-261016-1` 切出，所有批次按序提交到它。不要每批一个分支——批次间共享文件（PendingView、config.rs、forge/ 等），多分支会自己冲突。批次一（安全 P1）修完可随时把该分支合入开发线，不必等全部批次。

## 批次与依赖总览

| 批 | 工单 | 主题 | 前置关系 |
|----|------|------|----------|
| 1 | 01 02 03 | 安装/卸载安全 P1 | 最优先 |
| 2 | 04 05 06 | 前端 P1 | 05 先于批次 12 的 25（同文件） |
| 3 | 07 10 11 | 下载/安装门禁与健壮性 | 依赖批次 1 的 01 上下文 |
| 4 | 08 → 37 → 12 → 38 | IPC 暴露面 / 配置 / 文档落地 | 37 依赖 08；12 与 38 同改 config.rs 故同批 |
| 5 | 14 → 15 → 23 | forge 网络面（先行为后重构） | 同改 forge/，必须同批 |
| 6 | 16 → 35 → 21 | 归一化与搜索行为 | 35 对齐 16 的口径，必须同批 |
| 7 | 19 22 13 | 并发与持久化健壮性 | 22 先于批次 13 的 36（schema 测试联动） |
| 8 | 17 18 33 | 前端健壮性（hooks/缓存） | 无 |
| 9 | 31 34 32 | 前端出口收口与类型卫生 | 无 |
| 10 | 20 29 | i18n 专项 + 清理 | 无 |
| 11 | 24 27 28 | 重复与口径收口 | 与批次 2/10 同文件但已串行 |
| 12 | 25 26 | 巨型重构（PendingView / catalog） | 依赖批次 2 已改完 05 |
| 13 | 36 | 测试与工具链补强 | 依赖批次 7 的 22 |

已拍板不再处理的：09、30（resolved，方向见各自工单 Comments，执行时**不要重新发挥**）。

---

## 批次 1 —— 安装/卸载安全 P1（01 02 03）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 1（共 3 张，全部 Rust）。
分支：从 dev-261016-1 切出 fix/code-review-2026-10-21（已存在则直接切过去续用）。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/01-install-fallback-cmd-injection.md
  .scratch/code-review-2026-10-21/issues/02-uninstall-lnk-path-traversal.md
  .scratch/code-review-2026-10-21/issues/03-uninstall-cmd-injection.md
流程（每张）：开工先把工单 Status: 改为 claimed；按工单"修复方向"实施；完成后在工单
底部追加 ## Comments 记录实际改动；Status: 置为 resolved。每张工单一个 commit，
message 带工单号（如 fix(security): #01 ...）。
验证：src-tauri 下 cargo test 与 cargo clippy -- -D warnings；全部完成后两命令全量再跑
一遍并汇报。不要处理本批之外的工单；09/30 号已 resolved，方向以工单 Comments 为准。
```

## 批次 2 —— 前端 P1（04 05 06）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 2（共 3 张，前端 TS/React）。
分支：切到 fix/code-review-2026-10-21 续用（不存在则从 dev-261016-1 切出）。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/04-toggle-favorite-unhandled-rejection.md
  .scratch/code-review-2026-10-21/issues/05-pending-save-callbacks-stuck.md
  .scratch/code-review-2026-10-21/issues/06-error-boundary-and-load-error-states.md
流程（每张）：开工先把工单 Status: 改为 claimed；按"修复方向"实施；完成后追加
## Comments 记录改动；Status: 置为 resolved。每张一个 commit，message 带工单号。
验证：pnpm vitest run 全量通过；涉及类型处确保 pnpm build（含 tsc）通过。全部完成后
汇报。不要处理本批之外的工单；注意 05 改动的 PendingView 回调结构是批次 12 拆分
（issue 25）的前置，保持改动最小、不趁机重构。
```

## 批次 3 —— 下载/安装门禁与健壮性（07 10 11）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 3（共 3 张，Rust 为主）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/07-unverified-install-and-mirror-gate.md
  .scratch/code-review-2026-10-21/issues/10-installer-robustness-package.md
  .scratch/code-review-2026-10-21/issues/11-deeplink-byte-slice-panic.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：07 的"无校验资产默认拒绝"方向由 CONTEXT.md D3 决定，UI 警示+显式确认放行，
不要改成静默放行；10 是七小项打包，逐项小 commit 可合并为一张工单一个 commit。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings；pnpm vitest run（11 有
前端联动）。全部完成后汇报。不要处理本批之外的工单。
```

## 批次 4 —— IPC 暴露面 / 配置 / 文档落地（08 → 37 → 12 → 38）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 4（共 4 张，顺序有依赖，勿调换）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（严格按此顺序）：
  .scratch/code-review-2026-10-21/issues/08-ipc-token-exposure.md
  .scratch/code-review-2026-10-21/issues/37-token-risk-adr-and-backup-exclusion.md
  .scratch/code-review-2026-10-21/issues/12-config-toml-candidate-drift.md
  .scratch/code-review-2026-10-21/issues/38-doc-drift-remediation.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
既定决策（不要重新发挥）：37 的方向是 09 号拍板的"维持 SQLite 明文、只做 IPC 收口、
备份导出排除令牌"，见 09/37 工单 Comments；38 的方向是 30 号拍板的"保留第三 Client、
license 以 config.toml 为运行时源"，见 30/38 工单 Comments。12 与 38 都改 config.rs，
顺序执行避免自我冲突。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings（38 的逐项相等测试必须
真实跑过）；ADR/CONTEXT 文档改动遵循"写现状"规则。全部完成后汇报。
```

## 批次 5 —— forge 网络面（14 → 15 → 23）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 5（共 3 张，全在 forge/ 与 github/，
同文件多，按序执行勿调换）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（严格按此顺序）：
  .scratch/code-review-2026-10-21/issues/14-forge-url-encoding.md
  .scratch/code-review-2026-10-21/issues/15-forge-rate-limit-parity.md
  .scratch/code-review-2026-10-21/issues/23-forge-provider-dedup.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：14/15 先修行为，23 是纯重构（trait 对象化收 9 处复制），必须在 14/15 落地后
再做以免重构冲掉修改；23 重构以 cargo test 全绿为准，不改任何对外行为。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings。全部完成后汇报。
```

## 批次 6 —— 归一化与搜索行为（16 → 35 → 21）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 6（共 3 张，前后端都有）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（严格按此顺序）：
  .scratch/code-review-2026-10-21/issues/16-icon-coord-normalization-bypass.md
  .scratch/code-review-2026-10-21/issues/35-custom-draft-forge-gate.md
  .scratch/code-review-2026-10-21/issues/21-github-search-silent-failure.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：16 确立 canonical_app_id 唯一归一口径后，35 的前端 forge 门禁与 enrich 键
必须复用同一语义（前端 normalizeId 与后端对齐），21 的"未知 license 显式 unknown、
门禁按不放行"对齐 ADR-0018。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings；pnpm vitest run。全部
完成后汇报。不要处理本批之外的工单。
```

## 批次 7 —— 并发与持久化健壮性（19 22 13）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 7（共 3 张，Rust + TS 混合）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/19-trend-cache-write-race.md
  .scratch/code-review-2026-10-21/issues/22-db-migration-and-transaction.md
  .scratch/code-review-2026-10-21/issues/13-scanner-blocking-main-thread.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：22 引入 user_version 迁移机制时保持对现有 18 表的兼容（v0 = 现状起步），
它是批次 13（issue 36）里 schema 迁移测试的前置。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings；pnpm vitest run（19 是
前端缓存竞态）。全部完成后汇报。
```

## 批次 8 —— 前端健壮性（17 18 33）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 8（共 3 张，前端 hooks/services）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/17-oauth-poll-leak.md
  .scratch/code-review-2026-10-21/issues/18-settings-persist-robustness.md
  .scratch/code-review-2026-10-21/issues/33-iconstore-bounds.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：18 的 TTL 挡位 '0' 被吞是真实挡位（实时校验档），修复时保留 '0'；33 的容量
上限数值参照 D9 榜缓存"内存 200 有界"的先例并在 Comments 记录取值理由。
验证：pnpm vitest run 全量；pnpm build（tsc）通过。全部完成后汇报。
```

## 批次 9 —— 前端出口收口与类型卫生（31 34 32）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 9（共 3 张，前端架构收口）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/34-cmd-table-alignment.md
  .scratch/code-review-2026-10-21/issues/31-frontend-invoke-gate.md
  .scratch/code-review-2026-10-21/issues/32-type-hygiene.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：34 先把 CMD 表补齐（含 CI 对齐测试的想法，见工单），31 的 noDirectInvoke
扩扫与插件命令 allowlist 豁免在此基础上做；32 的 noUncheckedIndexedAccess 若引发
面过大，可只做 cast 收口并在 Comments 记录 tsconfig 项留待单独一轮（工单允许）。
验证：pnpm vitest run（含新对齐测试）；pnpm build（tsc）。全部完成后汇报。
```

## 批次 10 —— i18n 专项 + 清理（20 29）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 10（共 2 张，20 工作量大、29 极小）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/20-i18n-components-hardcoded.md
  .scratch/code-review-2026-10-21/issues/29-dead-code-and-comment-hygiene.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：20 先迁 AppDetailModal 三文件（Header/AssetList/IconLevelBadge）与 App.tsx
两处，再扩展 i18n 测试扫描至 components/；locales zh/en 两侧必须同步补 key（当前
各 580 键对齐，迁移后保持对齐）。29 顺手清掉（死代码 + 两条历史叙述注释）。
验证：pnpm vitest run（含扩展后的 i18n 测试）；pnpm build。全部完成后汇报。
```

## 批次 11 —— 重复与口径收口（24 27 28）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 11（共 3 张，前后端重复代码收口）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/24-unique-source-consolidation.md
  .scratch/code-review-2026-10-21/issues/27-data-clumps-structs.md
  .scratch/code-review-2026-10-21/issues/28-frontend-dup-shapes.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：24 是规范硬违规合集（唯一口径），删除 collect_custom_app 命令时同步清前端
死绑定与测试引用；27 的 models 抽公共子结构必须保持 serde 平面 JSON 契约不变
（#[serde(flatten)]）。
验证：src-tauri 下 cargo test + cargo clippy -- -D warnings；pnpm vitest run。全部
完成后汇报。
```

## 批次 12 —— 巨型重构（25 26）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 12（共 2 张，均为大重构）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单（按序）：
  .scratch/code-review-2026-10-21/issues/25-frontend-giant-component-split.md
  .scratch/code-review-2026-10-21/issues/26-catalog-long-function-refactor.md
流程：同前（claimed → 修复 → ## Comments → resolved，每张一个 commit 带工单号）。
注意：这是纯行为保持的重构批次——25 拆 PendingView/App.tsx/集中导航时以批次 2
已修的回调结构为基线，不混入新行为；26 拆 get_app_details_impl 时三处"读缓存→
盖章→返回"必须收敛为同一 helper，不改缓存语义。重构以全量测试绿灯为唯一验收。
验证：pnpm vitest run + pnpm build；src-tauri 下 cargo test + cargo clippy。全部
完成后汇报。
```

## 批次 13 —— 测试与工具链补强（36）

```
在 Z:\rust_workplace\z-store 执行代码审查修复批次 13（共 1 张，质量基建，工作量大）。
分支：切到 fix/code-review-2026-10-21 续用。
本批工单：
  .scratch/code-review-2026-10-21/issues/36-test-and-tooling-blindspots.md
流程：claimed → 按"修复方向"实施 → ## Comments 记录改动 → resolved。
注意：按工单的风险排序做（z-log 镜像 → useDetailCacheSync/useDeepLink → 其余
hooks → coverage 接入 → 种子 schema 校验）；coverage 先接入并出报告，阈值可以在
Comments 里给建议待维护者定。36 依赖批次 7 已落地的 user_version 迁移机制。
验证：pnpm vitest run（含新增测试与 coverage）+ pnpm build；src-tauri 下
cargo test。全部完成后汇报，并给出各批次累计的工单完成度核对（对照 report.md 索引）。
```

---

## 收尾

全部 13 批完成后：把 `fix/code-review-2026-10-21` 合回开发线；report.md 索引表应全部为 resolved；本文件可归档。
