# Feature Spec: 系统存量开源软件扫描与纳管 (feature-app-import)

> 借鉴 Komi Store (E1 External Imports) 与 Z-Store PRD FR-5.3，实现本地已安装开源软件自动识别、置信度匹配与一键版本接管。

## 1. 目标与范围

- **存量扫描**：在 Windows 端自动遍历注册表与快捷方式，提取软件名称、版本、Publisher、安装路径与主程序路径。
- **智能打分匹配**：基于 Z-Store 精选收录库 (`catalog.json`) 倒排索引与启发式算法（名称相似度、别名、可执行程序名、发布者），在本地离线计算匹配置信度。
- **纳管更新与可靠启动**：用户确认后，一键将存量软件写入本地 SQLite `installed_apps` 表，无缝接入 Z-Store 的版本检测与自动升级链路；支持在已装管理页面一键安全启动应用（`launch_app`）。

## 2. 实施 Issue 清单

- `01-windows-registry-scanner.md`: Windows 注册表与已装软件特征提取引擎
- `02-catalog-fingerprint-matcher.md`: 本地 Catalog 倒排索引与置信度打分算法
- `03-import-wizard-ui.md`: 前端“发现本地开源软件”纳管向导与交互卡片

> 范围外已实现注记：双 feed 自更新（`latest.json` / `latest-cn.json`，`utils/updateManifest.ts:308-319`）与客户端行降级展示（`ClientUpdateRow.tsx:40-46`）已落地，本特性不重复覆盖。
