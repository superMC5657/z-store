# Issue 03: 前端“发现本地开源软件”纳管向导与交互卡片

Status: resolved

## 描述

在前端“已安装应用”主视图中落地存量扫描与纳管交互：
1. 顶部操作栏新增“扫描本地开源软件 (Scan Local Apps)”按钮（带微光扫动动效）。
2. 实现 `AppImportModal` / 纳管向导浮层：
   - 扫描进度指示（展示已扫描软件数量）；
   - 扫描结果列表：展示检测到的软件名称、本地版本、匹配置信度徽章（高置信度带绿色盾牌）、匹配到的 GitHub 仓库。
   - 用户可勾选/取消勾选，并支持手动修正或输入自定义仓库地址。
3. 一键纳管执行：
   - 批量调用 Tauri IPC 写入 `installed_apps` 表（`install_method: 'system_import'`）；
   - 写入完成后刷新已安装列表，并自动触发一次 ETag 更新探测。

## Comments

- `src/components/AppImportModal.tsx` 已完成实现，基于 Fluent 2.0 亚克力材质、模糊层与置信度徽章体系。
- `src/App.tsx` 与 `src/views/InstalledView.tsx` 串联打通，一键纳管后自动刷新已安装应用列表与触发新版本探测。
- `pnpm typecheck` 0 错误，`pnpm build` 生产构建成功。

