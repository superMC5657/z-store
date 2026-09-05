# CONTEXT.md: Z-Store 领域模型与核心契约

本项目为 **Z-Store**，一个基于 **Tauri 2 + Rust + React 19 + Fluent Design 2.0** 构建的轻量级跨平台开源应用商店。

---

## 一、统一领域词汇表 (Domain Glossary)

所有代码、Issue、ADR 与文档必须严格使用以下标准术语，严禁随意使用未经定义的同义词：

| 标准术语 (Term) | 英文标识 | 领域定义与业务边界 | 避免使用的非规范称呼 |
|---|---|---|---|
| **精选收录库** | `Curated Catalog` | 随客户端内置或增量同步的知名开源应用元数据清单，包含中文本地化别名、图标、官方仓库坐标等。 | 应用市场、软件仓库 |
| **应用概要** | `AppSummary` | 列表页展示的轻量级实体，包含 Star 数、协议、分类、图标与最新版本信息。 | 应用简报、AppInfo |
| **应用详情** | `AppDetail` | 点击进入弹窗呈现的完整元数据，包含对应 Release 的构建资产列表 (`assets`)、官方 README Markdown 与签名证书指纹。 | 详细信息、FullApp |
| **构建资产** | `ReleaseAsset` | Release 附带的编译产物二进制包（如 `.msi`、`.exe`、`.zip`、`.deb`、`.dmg`），带有平台架构分类。 | 附件、下载包、安装文件 |
| **托管源提供者** | `ForgeProvider` | 统一源代码托管抽象层，原生支持 GitHub、Codeberg、Gitea、GitLab 等开源代码源。详见 ADR-0006。 | 仓库源、平台接口 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理文件下载与 API 的反代节点（如 `gh-proxy.com`），支持动态测速与透明重写。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 Z-Store 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测。 | 本地缓存、HTTP缓存 |
| **清单同步** | `Manifest Catalog Sync` | 客户端从公开可维护的开源收录仓库动态拉取或刷新应用元数据清单的机制，详见 ADR-0007。 | 清单下载、列表更新 |
| **缓存生存时效** | `Cache TTL` | 客户端本地持久化详情的有效周期（默认 30 分钟，支持 0~1440 分钟用户自定义），过期后触发带 ETag 的条件重新验证，详见 ADR-0007。 | 缓存过期时间、过期策略 |
| **便携版应用** | `Portable App` | 免安装 ZIP 压缩包，解压至用户 AppData 目录，自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式 (D-轻1 冰川浅蓝) 与暗黑模式 (D-轻4 晶透亚克力) 的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 纯粹开源 (Strictly FLOSS)**:
   - 仅收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等主流托管平台且拥有 OSI 认证开源协议的软件，严禁集成任何闭源专有软件包或商业广告推广。
2. **D2 零服务器成本与按需直连 (Serverless Direct API & Open Manifest Sync)**:
   - 客户端从公开维护的开源清单仓库（Open Manifest Catalog Repository）增量同步精选应用元数据（包含分类、中文别名、图标、官方仓库坐标等）；
   - 应用深度详情与构建资产通过 `ForgeProvider` 抽象层按需直连各代码源官方 REST API 获取，不设中心化聚合后端；
   - 本地 SQLite (`z_store.db`) 维护用户可配置的 TTL 缓存（默认 30 分钟，支持 0~1440 分钟自由调节），配合 HTTP ETag 304 条件请求实现零配额消耗延长缓存时效；在离线或请求失败时自动平滑回退至本地持久化数据（详见 ADR-0007）。
   - 所有已安装记录、用户设置、主机令牌（PAT）、更新规则与本地历史均保存在客户端本地嵌入式 SQLite 中。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
   - 所有下载的二进制安装包强制流式计算 SHA-256 哈希值；若官方提供了预期哈希清单，必须严格比对，哈希不符立即强行阻断并销毁临时文件；在 Windows 下结合 Authenticode 证书指纹与有效性强校验（详见 ADR-0004）。
4. **D4 深度融合 Windows 11 Fluent 2.0 (Native Design System)**:
   - 界面遵循微软 Fluent Design 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射描边、微动效与系统级深浅色自适应。
