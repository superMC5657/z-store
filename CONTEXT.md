# CONTEXT.md: Z-Store 领域模型与核心契约

本项目为 **Z-Store**，一个基于 **Tauri 2 + Rust + React 19 + Fluent Design 2.0** 构建的轻量级跨平台开源应用商店。

---

## 一、统一领域词汇表 (Domain Glossary)

所有代码、Issue、ADR 与文档必须严格使用以下标准术语，严禁随意使用未经定义的同义词：

| 标准术语 (Term) | 英文标识 | 领域定义与业务边界 | 避免使用的非规范称呼 |
|---|---|---|---|
| **精选收录库** | `Curated Catalog` | 随客户端内置或增量同步的知名开源应用元数据清单，包含中文本地化别名、图标、官方仓库坐标等。 | 应用市场、软件仓库 |
| **应用概要** | `AppSummary` | 列表页展示的轻量级实体，包含 Star 数、协议、分类、图标与最新版本信息。 | 应用简报、AppInfo |
| **应用详情** | `AppDetail` | 点击进入弹窗呈现的完整元数据，包含完整 Release 列表、官方 README Markdown 与签名证书指纹。 | 详细信息、FullApp |
| **构建资产** | `ReleaseAsset` | GitHub Release 附带的编译产物二进制包（如 `.msi`、`.exe`、`.zip`、`.deb`），带有平台架构分类。 | 附件、下载包、安装文件 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理 GitHub 文件下载与 API 的反代节点（如 `gh-proxy.com`），支持动态测速与透明重写。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 Z-Store 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测。 | 本地缓存、HTTP缓存 |
| **便携版应用** | `Portable App` | 免安装 ZIP 压缩包，解压至用户 AppData 目录，自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式 (D-轻1 冰川浅蓝) 与暗黑模式 (D-轻4 晶透亚克力) 的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 纯粹开源 (Strictly FLOSS)**:
   - 仅收录和分发托管于 GitHub 且拥有 OSI 认证开源协议的软件，严禁集成任何闭源专有软件包或商业广告推广。
2. **D2 零服务器成本 (Serverless Direct API)**:
   - 客户端直连 GitHub REST API 获取最新 Release，不设中心化后端服务器。
   - 所有已安装记录、用户设置与 ETag 缓存均保存在客户端本地嵌入式 SQLite (`z_store.db`) 中。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
   - 所有经加速镜像代理下载的二进制安装包，必须通过流式计算哈希与 GitHub 官方发布清单或已知哈希进行严格比对。哈希不匹配时必须强行阻断安装并销毁临时文件。
4. **D4 深度融合 Windows 11 Fluent 2.0 (Native Design System)**:
   - 界面遵循微软 Fluent Design 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射描边、微动效与系统级深浅色自适应。
