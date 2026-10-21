# Feature Spec: Z-Store v0.1.0 (MVP)

> 依照 `docs/PRD.md` 与 `docs/应用需求报告.md`，基于 Tauri 2 + Rust + React 19 + Fluent Design 2.0 构建跨平台开源应用商店。

## 1. 目标与范围

- **跨平台底座**：Windows 11 首要打磨（无边框、亚克力、窗口贴靠、快捷方式管理），架构上预留 Linux/macOS/Android。
- **开源分发**：内置收录 40+ 款主流开源软件，支持名称、别名、仓库坐标快速检索与未收录仓库在线解析。
- **网络与安全**：直连 GitHub API + 本地 SQLite ETag 304 缓存；镜像加速二进制下载 + SHA-256 流式校验防篡改。
- **现代前端**：React 19 + TypeScript + Vite 6 + 原生 Fluent 2.0 CSS，覆盖首页、分类、趋势、更新、已装、设置六大核心视图与详情弹窗。

## 2. 实施分工与 Issue 清单

- `01-core-scaffold.md`: 核心工程脚手架与 Tauri 2 运行时配置
- `02-database-and-cache.md`: SQLite 本地持久化与 ETag 条件缓存
- `03-github-api-and-catalog.md`: Catalog 倒排索引检索与 GitHub 直连通信
- `04-mirror-and-installer.md`: 镜像并发测速与 SHA-256 防篡改安装引擎
- `05-fluent-ui-views.md`: React 19 前端 Fluent 2.0 交互视图与详情弹窗
- `06-integration-and-verification.md`: 全链路质量验证与构建交付

## 3. 决策 B：设备平台空选择语义（空筛选）

- 设备平台筛选为空数组或仅含未知值时归一化为 `[]`；取消选中可达 `[]`，不设最少保留一项 guard。
- `[]` 表示什么都不选（空选择 = 什么都不选），相关视图渲染空筛选状态，而非回退为全部（`全部`仍为不过滤快捷方式）。缺少本地键时回退全选，仅显式 `[]` 渲染空状态。
