# 01: 同步转正后立即可见（刷新 customApps）

**What to build:** 手动/自动 `sync_catalog` 成功后，已转正归档行要立刻从「本地收录」移到「已归档」，不依赖重启。现在 `SettingsView.tsx:104` 只派发 `zstore:catalog-synced`，而 App 的 `customApps` 只监听 `zstore:custom-apps-changed`（`App.tsx:117`），转正提示与待收录页状态互相矛盾。

**Status:** resolved

- [x] 同步成功 seam 派发 `zstore:custom-apps-changed`（`SettingsView.tsx` 同步成功分支，一处收口）→ App 现有监听重载 `customApps`
- [x] 手动同步是唯一入口（`syncCatalog` 仅 Settings 调用）；启动自动同步路径不存在，无需额外 seam
- [x] 测试：`SettingsView.test.tsx` 断言同步成功后两条事件均派发
- [x] `tsc --noEmit` + `SettingsView` / 本地库相关 vitest 通过

## Comments
- 2026-10-20：已实施。`SettingsView.tsx` 同步成功后连发 `catalog-synced` + `custom-apps-changed`；App 既有监听负责重载 customApps，转正行立即离开「本地收录」。验证：`SettingsView.test.tsx` 7 项通过。
