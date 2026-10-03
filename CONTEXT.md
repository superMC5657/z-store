# CONTEXT.md: Z-Store 领域模型与核心契约

本项目为 **Z-Store**，一个基于 **Tauri 2 + Rust + React 19** 构建的轻量级跨平台开源应用商店（界面以 Linear 去彩单色为主，Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。

---

## 一、统一领域词汇表 (Domain Glossary)

所有代码、Issue、ADR 与文档必须严格使用以下标准术语，严禁随意使用未经定义的同义词：

| 标准术语 (Term) | 英文标识 | 领域定义与业务边界 | 避免使用的非规范称呼 |
|---|---|---|---|
| **精选收录库** | `Curated Catalog` | 包含应用英文原名、图标、官方仓库坐标等元数据的精选开源应用清单。 | 应用市场、软件仓库 |
| **独立生态清单仓库** | `Decoupled Catalog Repository` | 独立维护于 `superMC5657/z-store-catalog` 的开源清单数据仓库，独立运作保鲜 CI 与准入校验，详见 ADR-0009。 | 中心数据库、后台仓库 |
| **种子清单兜底** | `Catalog Seed Fallback` | 客户端本地打包内置的 `catalog.json` 静态种子，确保初次安装或离线断网时 0 延迟秒开列表。 | 默认缓存、离线数据包 |
| **多端应用标识符** | `Platform Identifiers` | 按操作系统（Windows、Linux、macOS、Android、iOS）区分的原生进程/包名标识符映射字典，用于精准匹配管理与启动。 | 执行文件名、进程表 |
| **双维目录筛选** | `Bi-dimensional Filter` | 分类浏览中心提供的“设备平台（全部/Windows/Android/macOS/Linux/iOS）”与“功能分类（开发、影音等 10 类）”双维交叉过滤机制。其中设备平台轴取值为全部 + Windows/Android/macOS/Linux/iOS 五端，全部为不过滤快捷方式；空选择（`[]`）表示什么都不选，视图渲染空筛选状态；缺少本地键时回退全选，仅显式 `[]` 渲染空状态。 | 标签过滤、分类切换 |
| **应用概要** | `AppSummary` | 列表页展示的轻量级实体，包含 Star 数、协议、分类、图标、多端平台支持与最新版本信息。 | 应用简报、AppInfo |
| **应用详情** | `AppDetail` | 弹窗呈现的完整元数据，包含对应 Release 的构建资产列表 (`assets`)、官方 README Markdown、分类与多端标识符等字段（以 `src-tauri/src/models.rs` 为准）。 | 详细信息、FullApp |
| **构建资产** | `ReleaseAsset` | Release 附带的编译产物二进制包（如 `.msi`、`.exe`、`.zip`、`.deb`、`.dmg`、`.apk`），带有平台架构分类。 | 附件、下载包、安装文件 |
| **托管源提供者** | `ForgeProvider` | 统一源代码托管抽象层，原生支持 GitHub、Codeberg、Gitea、GitLab 等开源代码源。详见 ADR-0006。 | 仓库源、平台接口 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理文件下载与 API 的反代节点（如 `gh-proxy.com`），支持动态测速与透明重写。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 Z-Store 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测。 | 本地缓存、HTTP缓存 |
| **清单同步** | `Manifest Catalog Sync` | 客户端从独立开源收录仓库动态拉取或增量刷新应用元数据清单的机制，详见 ADR-0007 与 ADR-0009。 | 清单下载、列表更新 |
| **缓存生存时效** | `Cache TTL` | 客户端本地持久化详情的有效周期（基线 30 分钟，设置页不暴露；后端对改库/导入值按挡位归一化），过期后触发带 ETag 的条件重新验证；仅约束详情浏览，更新发现（更新中心/关注动态）每次走 ETag 轻量探查，不受其约束。 | 缓存过期时间、过期策略 |
| **应用内仅下载** | `Download-Only` | 宿主不可安装的资产经应用内通道下载落盘、不调用安装器的模式，复用安装通道的镜像改写、SHA-256 校验与下载进度事件，落盘后可一键定位文件。 | 浏览器下载、直链下载 |
| **便携版应用** | `Portable App` | 免安装 ZIP 压缩包，解压至用户 AppData 目录，自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式 (D-轻1 冰川浅蓝) 与暗黑模式 (D-轻4 晶透亚克力) 的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |
| **协议深层链接** | `Deep Linking` | 注册系统级 `zstore://` URL Scheme，支持浏览器与外部链接一键呼起客户端直达详情、安装或搜索路由。 | 外部协议、跳转链接 |
| **版本控制规则** | `Update Rule` | 持久化于本地 SQLite 的应用更新策略，支持跳过指定破坏性版本、永久锁定版本与隐藏特定仓库。 | 忽略更新、锁定版本 |
| **SHA-256 完整性校验** | `Checksum Verification` | 下载后强制 SHA-256 流式校验，与 `checksums.txt` / `SHA256SUMS` 比对（详见 ADR-0004）。 | Authenticode、证书校验、安全验签 |
| **存量应用管理** | `External App Management` | 扫描操作系统已安装软件（Windows 注册表及程序目录），通过倒排索引与启发式打分智能匹配开源清单，一键添加至管理列表并接管更新。 | 软件扫描、外部导入、应用纳管 |
| **Fluent 2 矢量图标体系** | `Fluent Vector Icon System` | 全站功能操作、导航菜单、设备平台标识及状态指示全面采用轻量线性矢量图标（`lucide-react` 与统一单色 SVG），严格遵循 Fluent 2.0 视觉规范与 `currentColor` 主题自适应，配合 CSS 微动效与状态指示原点。 | 功能Emoji、彩色贴图、图标库 |
| **主机配额指示器** | `Host Quota Indicator` | 各托管平台 API 调用配额监听与告警机制（主界面已隐藏胶囊徽章，收敛于账号卡片按需管理）。 | 配额胶囊、限流状态 |
| **下载加速代理** | `Mirror Download Proxy` | 仅用于大文件下载提速的加速镜像节点重写（如 `gh-proxy.com`）；仅改变下载 URL 前缀，API 与登录直接走系统网络通道。 | 出站代理、镜像节点 |
| **GitHub登录胶囊** | `Account Capsule` | 侧栏底部常驻账号入口：未登录显示 GitHub 快捷登录入口，已登录显示用户头像与用户名；点击直达设置中心账号卡片（`#settings-account`）。 | 侧边栏按钮、用户面板 |
| **设置中心分组** | `Settings Groups` | `SettingsView` 规范 5 组结构：外观与显示 / 更新与提醒 / 存储与下载 / 账号与网络 / 数据备份。 | 设置页、选项卡 |
| **OAuth Device Flow** | `OAuth Device Flow` | GitHub 登录设备码流程，Client ID 取自统一配置中枢 `config.toml`（支持设置项覆盖）；轮询容错 10 次、单次 10s 超时；`Expired` / `Denied` 独立状态机展示。 | 网页登录、PAT 登录 |
| **流式更新检查** | `Streaming Update Check` | 更新中心采用并发管道流式检测，实时发射 `zstore://update-check-progress` 推流事件，驱动逐项跳出微动效。 | 批量更新、后台检测 |
| **统一配置中枢** | `Unified Project Config` | `src-tauri/config.toml` 作为项目超参与默认配置的单一配置源 (SSOT)，结合编译期宏内置兜底与运行期动态重载。 | 配置文件、硬编码常量 |
| **规范应用标识** | `Canonical App Id` | 全系统唯一应用标识，统一为小写 `owner/repo`（GitHub）或 `forge[:host]:owner/repo`（多源）；id 即仓库坐标本身。入站标识（命令/深链/导入）一律经 `canonical_app_id()` 归一化，目录检索仅按 id 唯一匹配。详见 ADR-0010。 | 随机 UUID、应用别名 ID |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 纯粹开源 (Strictly FLOSS)**:
   - 仅收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等主流开源托管平台且拥有 OSI 认证开源协议的软件，严禁集成任何闭源专有软件包或商业广告推广。
2. **D2 零服务器成本与解耦清单同步 (Serverless Direct API & Decoupled Manifest Sync)**:
   - 客户端从独立开源清单仓库（`superMC5657/z-store-catalog`）增量同步精选应用元数据（包含分类、英文原名、图标、多端标识符与仓库坐标等）；本地预置 `catalog.json` 种子清单兜底（详见 ADR-0009）。
   - 应用深度详情与构建资产通过 `ForgeProvider` 抽象层按需直连各代码源官方 REST API 获取，不设中心化聚合后端；
   - 本地 SQLite (`z_store.db`) 维护基于单一配置源（`src-tauri/config.toml`）的 TTL 缓存（默认 30 分钟），配合 HTTP ETag 304 条件请求实现零配额消耗延长缓存时效；该 TTL 仅约束详情浏览，更新检查（更新中心/关注动态）独立于 TTL、每次经 ETag 轻量探查；离线或请求失败时平滑回退本地持久化数据（详见 ADR-0007）。
   - 网络层自动继承操作系统代理与环境变量（Windows 下启动时自探测注册表且 https 优先，支持 Clash / v2ray / TUN 模式透明截获），与针对 Release 大文件下载的加速镜像节点正交可叠加。
   - 所有已安装记录、用户设置、主机令牌（PAT）、更新规则、关注应用与本地足迹均保存在客户端本地嵌入式 SQLite 中（14 张核心表，见 `src-tauri/src/db/schema.rs`；其中 `icon_cache_meta` 追踪收录应用图标缓存来源，`app_icon_cycles` 追踪图标轮换状态，两表分流）。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
    - 所有下载的二进制安装包强制流式计算 SHA-256 哈希值并与官方校验清单比对，哈希不符立即强行阻断并销毁临时文件（详见 ADR-0004）。
4. **D4 Linear 去彩单色界面 (Monochrome Design System)**:
   - 界面采用 Linear 风格的去彩单色体系：黑白灰画布、hairline 微边框、6/8px 圆角、510/590 字重与系统级深浅色自适应（Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。
   - 采用统一的线性矢量图标体系（统一由 `lucide-react` 14px/stroke 1.5 及单色矢量 SVG 驱动并适配 `currentColor`），状态反馈采用标准 CSS 微动效（如旋转 `.icon-spin`）与高亮状态指示原点（`.status-dot`），消除视觉割裂；基底保持单色，星级收藏（金 `#eab308`）、榜单排名（金/银/铜）与告警/错误等状态色为例外点缀，图标本体仍为单色 `currentColor`。
   - 侧栏底部常驻账号入口胶囊（`Account Capsule`），未登录显示登录入口，已登录呈现头像与用户名，点击直达设置中心账号卡片（`#settings-account`）。
