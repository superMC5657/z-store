# Issue 24: 唯一口径收口：收录态判定 / raw has / 重复命令与函数

Status: resolved
Priority: P3（规范硬违规合集）
来源: 2026-10-21 全项目审查 · Standards 轴

## 描述

四处违反"唯一口径"声明（CONTEXT.md 词汇表与 selectors 自设注释），合并一单收口：

1. `src/app/selectors.ts:136-137` 注释声明"调用方禁止再手写 `installedIds.has(id)`
   raw 直查"，但 `src/views/FavoritesView.tsx:113,357` 仍裸用——大小写变体 ID 下与
   `isInstalled` 判态分叉。
2. `src/services/custom/mappers.ts:21` 重新手写 `collected||local_collected` 字面判定，
   违背 CONTEXT.md「收录态判定唯一口径为 `isCollectedStatus`（selectors 单一导出）」。
3. `src/app/selectors.ts:102-120`：`buildInstalledIds`/`buildManagedIds` 函数体逐字
   相同，产物恒等却双名。
4. `src-tauri/src/commands/catalog_custom.rs:437-462`：`collect_custom_app` 与
   `collect_local_app` 命令体完全相同，且前端 `collectCustomApp` 零生产调用（仅测试）
   ——冗余命令面。

## 修复方向

- FavoritesView 两处改 `isInstalled`；mappers 层向问题如层级依赖不允许，则把
  `isCollectedStatus` 下沉到 services 可达的共享模块再由 selectors 重导出，保持
  "单一导出口径"承诺成立。
- 合并 buildInstalledIds/buildManagedIds 为一个实现（保留双别名或统一命名，评估调用方）。
- 删除 `collect_custom_app`（保留 `collect_local_app`），同步删前端死绑定与测试引用。

## Comments

2026-10-21 修复（batch 11）：

1. FavoritesView 两处 `installedIds.has(...)` 裸用（批量安装 filter + 禁用态 every）改 `selectIsInstalled`，与卡片判态同口。
2. `isCollectedStatus` 下沉新建 `src/services/custom/status.ts`（services 层可达，mappers 直接消费，无 services→app 反向依赖）；selectors 改为单一重导出，`isLocalLibraryStatus`/PendingView/revertCollectedApp.test 等既有导入面零变化；CONTEXT.md 词汇表「本地收录态」条目同步改为"实现居 status.ts、selectors 单一重导出"。mappers `draftStatusFromWire` 字面判定改走共享函数（语义逐字等价）。
3. `buildInstalledIds`/`buildManagedIds` 合并为 `buildInstalledIdSet` 单实现（两集合恒等，判定分叉只在读取侧），`installedIds`/`managedIds` 两个 memo 保留双出口不变 hook 返回形状；badgeConsistency.test 注释同步。
4. `collect_custom_app` 命令删除（catalog_custom.rs 函数体 + lib.rs 注册 + 模块/ValidateMode 文档注释改指 `collect_local_app`）；前端死绑定全清：api.ts CMD 表与 tauriApi 导出、catalog.ts `collectCustomApp` 函数（连带内联只剩单调用方的 `collectByCommand` helper、删 `TauriCommand` 死导入）；ipcArgsNaming.test stub/调用/断言改单命令口径（collectCalls 2→1）。生产唯一调用点 App.tsx 走 `collectLocalApp` 不受影响；cmdAlignment 门禁两侧同删仍对齐。

验证：cargo check + clippy -D warnings 绿；tsc --noEmit 绿；受影响 4 个测试文件 30 用例绿（全量回归在批次末统一跑）。
