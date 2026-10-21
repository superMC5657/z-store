# Issue 31: D2 前端出口卡点：noDirectInvoke 只扫 views，2 处旁路

Status: resolved
Priority: P3（规范收口）
来源: 2026-10-21 全项目审查 · Spec 轴 + 前端核心分片

## 描述

D2/AGENTS.md 声明「前端唯一出口为 CMD 表 + tauriInvoke 派发，视图层禁直调 invoke」，
但 `noDirectInvoke.test.ts` 只递归扫描 `src/views`，components/services 层无卡点。现存
两处旁路：

1. `src/components/ClientUpdateRow.tsx:132-133`：直调 `invoke('plugin:process|restart')`。
2. `src/components/ResizeHandles.tsx:2`：唯一直接 import `@tauri-apps/api`（Window 窗口
   控制与事件，lazy 加载缓解但同属旁路）。

## 修复方向

- noDirectInvoke 扫描范围扩至 `src/components`（如插件命令确需直调，用显式 allowlist
  注释豁免，让豁免可见）。
- 两处旁路迁到 services 封装（如 `services/window.ts`），调用方走封装。

## Comments

- 扩扫后违规面实为三处而非两处：`TitleBar.tsx` 三键（minimize/toggleMaximize/close）
  与 ResizeHandles 同走 `@tauri-apps/api/window` 动态导入，工单抽查漏计，一并迁移。
- 迁移落点：新 `services/window.ts`（minimize/toggleMaximize/isMaximized/close
  + `startWindowResizeDragging` 含 ResizeHandles 既有语义：非 Tauri no-op、最大化态
  忽略拖拽、吞错保底；`WindowResizeDirection` 类型随封装导出，组件层不再需要
  `@tauri-apps/api/window` 的 type import）；新 `services/appProcess.ts`
  （`restartApp` 封装 `plugin:process|restart`）。失败原样抛出、浏览器降级 try/catch
  留在调用方（TitleBar/ClientUpdateRow 迁移前后行为逐字对齐）。
- allowlist 豁免的落法：迁移后 views/components 扫描面内**零**直调残留，无需条目式
  豁免清单；豁免收敛为 services 封装头注释（appProcess.ts 申明 `plugin:process|restart`
  为何不进 CMD 表——CMD 只收本仓后端命令，cmdAlignment 按后端注册集对齐，插件命令
  入表必挂；豁免可见性由注释承担，位置在唯一合法出口处）。
- 门禁规则（views + components 统一）：禁 `invoke(` 直调、禁 `@tauri-apps/api` 整个
  core API 前缀（原 views 只禁 `api/core`，现加宽到前缀——views 现状零使用，安全）、
  禁 `services/api/client`；官方插件 JS API（`@tauri-apps/plugin-*`，现存
  plugin-updater）视为合法高层封装不拦。「views 引 services/api 必须用 tauriApi
  命名」保持 views-only（components 有只引 `isTauri` 的合法形态）。
- 测试：noDirectInvoke 5 用例（扫描面 views+components）通过；components 全量
  13 文件 84 用例通过（ClientUpdateRow 桩不受影响）；`pnpm build` 绿。
