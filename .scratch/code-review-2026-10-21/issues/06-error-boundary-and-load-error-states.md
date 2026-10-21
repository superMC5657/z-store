# Issue 06: 无全局 ErrorBoundary，数据加载错误态缺失

Status: resolved
Priority: P1（前端健壮性）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

1. 全 src 无 React ErrorBoundary（`componentDidCatch`/`getDerivedStateFromError` 零
   命中）：任一组件渲染期异常整窗白屏，无降级 UI。
2. `src/app/hooks/useInstallState.ts:99` 已装列表初始加载 `catch(() => undefined)`
   静默，与空列表同呈现；`InstalledView.tsx:181` 仅有 EmptyState，无错误/重试区分。

## 修复方向

- 顶层加 ErrorBoundary（复用 D4 单色体系画错误卡 + 重载按钮），视图级可再加一层粒度。
- useInstallState 保存 error 态，InstalledView 呈现错误 + 重试，与空态区分。

## Comments

- 2026-10-21: 新增 `src/components/ErrorBoundary.tsx`（类组件，getDerivedStateFromError + componentDidCatch）：渲染期异常捕获后以单色错误卡降级（D4 单色口径：仅边框/文本层级 + RotateCcw 图标，btn-fluent 主按钮），展示错误详情（mono、可选中）与「重载应用」按钮（window.location.reload）；crash 经 zlogError 落日志（复用前端脱敏）。main.tsx 的 demo 与 Tauri 两条渲染路径均在 StrictMode 内包一层；未加视图级粒度（工单为"可再"，保持最小）。
- `useInstallState`：初始加载由 `.catch(() => undefined)` 静默改为保存 `installLoadError` 态；加载逻辑抽为 `loadInstalledApps`（进入已装页自动触发 + 兼作重试入口），成功清错误态。
- `InstalledView` 新增 `loadError`/`onRetryLoad` props：列表为空且 loadError 非空时呈现错误卡（AlertTriangle + `installed.load_failed_title`/`load_failed_desc` + 重试按钮），与空态明确区分；有数据时错误不抢占列表。
- App.tsx 接线：`installLoadError`/`loadInstalledApps` 透传 InstalledView。
- 新增 i18n key：`error.*`（顶层新命名空间）与 `installed.load_failed_title`/`load_failed_desc`/`retry_load`（zh-CN/en-US）。
- 新增 `ErrorBoundary.test.tsx`（3 例：正常渲染透传 / 崩溃出错误卡 / 重载按钮调 reload）与 `InstalledView.loadError.test.tsx`（3 例：错误卡+重试 / 无错误保持空态 / 有数据不抢错误卡）。
