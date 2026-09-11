# Z-Store

> 基于 GitHub / Multi-Forge Releases 的跨平台开源应用商店 · 深度融合 Windows 11 Fluent Design 2.0

![Z-Store License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.2-blue?logo=tauri)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)

---

## 🌟 项目定位与基石原则 (Core Principles)

**Z-Store 致力于成为开源世界的系统级应用商店**，把 GitHub 及主流开源托管平台的 Releases 转化为人人可用、一键安装、自动更新的跨平台现代化应用市场。

本项目严格遵循四大基石原则：

- **D1 纯粹开源 (Strictly FLOSS)**: 仅收录和分发具备 OSI 认证开源协议的软件项目，杜绝商业广告、捆绑流氓软件与闭源专有推广。
- **D2 零服务器成本与解耦清单同步 (Serverless & Decoupled Manifest Sync)**:
  - 基于独立的开源清单仓库（[superMC5657/z-store-catalog](https://github.com/superMC5657/z-store-catalog)）增量同步精选应用元数据，客户端本地预置 `catalog.json` 离线种子兜底，保障断网或首发秒开（详见 [ADR-0009](docs/adr/0009-catalog-manifest-repository-decoupling.md)）；
  - 客户端通过 `ForgeProvider` 抽象层**按需直连**托管平台官方 REST API 获取深度详情与构建资产，无需中心化专有后端；
  - 本地 SQLite 持久化结合统一配置源（`src-tauri/config.toml`）的 TTL 缓存（默认 30 分钟）与 **HTTP ETag 304 条件重新验证**，实现零 API 配额消耗延长时效与离线平滑降级（详见 [ADR-0007](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)）。
- **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
  - 默认利用高可用加速镜像代理大文件下载；
  - 下载后**强制流式计算 SHA-256 哈希**并与官方清单比对，哈希不符立即强行阻断并销毁临时文件；
  - Windows 端结合 Authenticode 数字证书指纹提取与有效性强核验，防御供应链投毒（详见 [ADR-0004](docs/adr/0004-streaming-installer-and-checksum-verification.md)）。
- **D4 深度融合 Fluent Design 2.0 (Native Design System)**:
  - 全面遵循微软 Windows 11 Fluent 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射高光描边、平滑微动效与系统级深浅色自适应（`light-dark()`、`in oklch`）；
  - 配套 [ADR-0005](docs/adr/0005-cross-platform-multi-mode-icon-specifications.md) 晶透双模标识体系。

---

## 🚀 核心功能与特色 (Key Features)

### 1. 🌐 解耦清单同步与按需详情获取
- **离线秒开与种子兜底**：客户端启动优先读取本地 `catalog.json` 种子清单，保证零网络延迟立即可用。
- **一键动态同步**：设置中心支持随时“立即同步收录库”，增量拉取独立生态仓库最新清单，支持配置自定义同步源与加速前缀。
- **TTL 智能缓存与 ETag 续期**：统一基线缓存 TTL（默认 30 分钟），过期后触发 ETag 304 条件请求，零配额消耗延长缓存新鲜度。

### 2. 🦊 多托管平台与多设备平台双维筛选
- **多托管源抽象**：`ForgeProvider` 统一抽象层原生支持 **GitHub**、**Codeberg**、**Forgejo** 与自建 **Gitea** 实例（[ADR-0006](docs/adr/0006-multi-forge-ecosystem-support.md)），跨平台统一仓库标识（`gh:`、`cb:`、`gitea:`），支持独立主机 PAT 与速率管理。
- **原生多端标识符结构**：元数据清单原生支持按操作系统划分的应用标识符体系（`identifiers`：Windows 进程/可执行文件名、Linux 进程名、macOS 应用名、Android/iOS 原生包名）。
- **双维交叉筛选**：分类中心支持按设备平台（全部设备 / Windows / Android / macOS / Linux / iOS）与功能分类（系统实用、开发工具、影音视听等 10 大分类）实时双维交叉过滤。

### 3. 🔍 存量已安装应用外部导入 (External App Import)
- 深度扫描 Windows 系统已安装软件（注册表 `Uninstall` 项与系统目录），提取软件名称、版本与安装路径。
- 基于倒排索引与启发式置信度打分算法（支持别名匹配与特征指纹），智能识别本地已装的开源软件（如 VLC、OBS、VS Code、Git 等），一键接管自动更新。

### 4. 🛡️ 细粒度版本控制与安全防御
- **版本控制中枢**：更新列表中可针对特定应用选择“跳过此版本”或“锁定当前版本（禁止自动更新）”，避免破坏性升级。
- **黑名单管理**：支持从推荐与搜索列表中隐藏不感兴趣的应用仓库。
- **Authenticode 验签**：Windows 平台自动检测并展示安装包的数字签名状态、签名者组织与证书 SHA-256 指纹。

### 5. 🌟 开发者全景生态与 GitHub Star 同步
- **开发者主页**：点击作者一键查看其名下所有的开源项目、开源许可协议与最新发布历史。
- **GitHub OAuth 登录**：Device Flow 免应用密钥登录，Client ID 遵循单一配置源（`src-tauri/config.toml`），支持在设置项中自定义覆盖。采用 `classify_device_poll` 明确区分 `Expired` 与 `Denied` 状态。
- **GitHub Star 导入**：登录后一键拉取个人 Star 列表中所有具备可用构建资产的开源项目。
- **本地足迹追踪**：自动记录并持久化搜索历史与最近浏览应用，支持一键快捷回访。

### 6. 🔄 检查更新流式推流与实时感知
- **实时推流动效**：更新检查基于并发管道流式拉取，后端通过 `zstore://update-check-progress` 逐项推流，前端呈现丝滑进度条与更新项逐项跳出微动效。
- **轻量版本嗅探**：更新检查仅拉取版本号与 Release 说明，结合 ETag 304 极速响应，不下载大体积 README 或非必要元数据。

### 7. 🔗 系统级协议与状态指示
- **深层链接唤起**：注册 `zstore://` URL Scheme，支持浏览器与外部命令行直接唤起客户端直达详情、安装或搜索。
- **API 速率胶囊**：视窗右下角常驻 API 配额指示器（Rate Limit Pill），动态告警剩余配额。
- **GitHub 账号胶囊**：侧栏底部常驻账号入口（`Account Capsule`），未登录状态下展示登录入口，登录后展示用户头像与用户名，点击直达设置中心账号卡片。

### 8. 🌐 网络代理与下载加速架构
- **下载加速代理**：针对 Release 二进制大文件下载拼接加速前缀（默认 `https://gh-proxy.com`），支持在设置中心配置、单键测速与快捷恢复直连。
- **系统代理与 TUN 截获**：客户端发出的 HTTP 请求天然受系统代理及本地代理工具（如 Clash / v2ray / TUN 模式）透明捕获，无需在应用内繁琐配置本地代理 IP/端口；Windows 启动时自探测注册表系统代理无缝衔接。

### 9. ⚙️ 设置中心 5 组架构
- 设置中心规范分为 5 个业务分组：`🖥️ 外观与显示`、`🔄 更新与提醒`、`👤 GitHub 账号与配额`、`🌐 网络与清单数据`、`💾 数据备份与恢复`。
- 全量项目超参与默认配置收敛于 `src-tauri/config.toml` 单一真相源，确保前后端与引擎默认行为严格对齐。

---

## 🛠️ 架构与技术栈

- **桌面底座**: Tauri 2.2 + Rust 1.77+
- **前端界面**: React 19 + TypeScript 5.7 + Vite 6 + 原生 Fluent 2.0 CSS
- **本地数据库**: 嵌入式 SQLite (`rusqlite` bundled，维护 13 张核心表)
- **配置中枢**: 单一基线配置源（`src-tauri/config.toml`），结合编译期内置兜底与外部重载机制
- **网络与下载**: `reqwest`（`json` / `stream` / `socks` 特性）+ ETag 条件缓存 + 并发镜像测速管道；自动继承系统代理与 TUN 模式
- **桌面开发配置**: `pnpm tauri:dev`（基于 `src-tauri/tauri.dev.conf.json` 配置本地安全策略）
- **安装引擎**: Windows MSI (`/qn`)、Setup EXE (`/S` / `/VERYSILENT`)、便携版 ZIP 自动解压与快捷方式生成、macOS (DMG/PKG) 及 Linux (deb/rpm/AppImage) 管道

---

## 📊 开发里程碑与功能交付现状

| 阶段 / 功能模块 | 规划定位 | 当前状态 | 核心成果与支撑规范 |
|---|---|---|---|
| **M0: 核心基座与 MVP** | 基础架构与 Windows 端闭环 | **100% 已交付** | 纯客户端直连、Fluent 2 亚克力界面、国内镜像加速管道 |
| **Feature A: 多代码托管平台** | Codeberg / Forgejo / Gitea | **100% 已交付** | `ForgeProvider` 抽象、多主机 Token 隔离 ([ADR-0006](docs/adr/0006-multi-forge-ecosystem-support.md)) |
| **Feature B: 存量应用纳管** | 扫描已装软件并接管更新 | **100% 已交付** | Windows 注册表扫描器、启发式倒排打分匹配引擎 |
| **Feature C: 版本控制与验签** | 跳过/锁定版本与证书核验 | **100% 已交付** | SQLite 版本规则表、Windows Authenticode 签名核验 ([ADR-0004](docs/adr/0004-streaming-installer-and-checksum-verification.md)) |
| **Feature D: 开发者生态** | 开发者全景与 Star 仓库同步 | **100% 已交付** | 开发者主页、GitHub Star 导入、搜索/浏览历史持久化 |
| **Feature E: 协议唤起与多端** | `zstore://` 路由与多端管道 | **100% 已交付** | URL Scheme 深度链接、API 配额药丸胶囊、类 Unix 安装管道 |
| **ADR-0007: 开放清单与缓存** | 开放清单同步 + 可配 TTL | **100% 已交付** | 远程 Manifest 仓库动态拉取、0~1440m TTL、ETag 304 零配额续期 |
| **ADR-0008: 出站代理与设置重构** | 出站代理 + OAuth 加固 + 设置 5 组 | **100% 已交付** | 系统代理透明捕获、OAuth 三级 Client ID、独立状态机、设置 5 组规范 ([ADR-0008](docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md)) |
| **ADR-0009: 清单解耦与多端体系** | 独立生态仓库 + 多端 Identifiers | **100% 已交付** | 解耦至 `superMC5657/z-store-catalog`、原生多端标识符结构、设备与分类双维筛选、单一配置源 ([ADR-0009](docs/adr/0009-catalog-manifest-repository-decoupling.md)) |
| **M1: 体验扩展与 PWA** | 移动适配与网页发现站 | **推进中** | Web/PWA 发现站规划、Android Shizuku 免 Root 安装预研 |

---

## 💻 本地开发指南

### 前置依赖
- [Node.js](https://nodejs.org/) (>= 18) 与 [pnpm](https://pnpm.io/) (>= 9)
- [Rust](https://rustup.rs/) (>= 1.77)
- C++ 构建工具（Windows 下需 Visual Studio C++ 生成工具）

### 安装与启动

```bash
# 1. 安装前端依赖
pnpm install

# 2. 运行自动化测试与类型检查
cargo test
pnpm typecheck

# 3. 启动前端浏览器开发预览
pnpm dev

# 4. 启动 Tauri 桌面完整应用
pnpm tauri:dev
```

### 构建打包

```bash
# 构建 Windows 安装包 (NSIS)
pnpm tauri build
```

---

## 📄 架构决策记录 (ADR) 与核心文档

- [ADR-0001: 采用 Tauri 2 与 React 19 + Fluent 2.0 架构](docs/adr/0001-tauri2-and-react-fluent-architecture.md)
- [ADR-0002: 客户端直连 GitHub API 与加速镜像下载管道](docs/adr/0002-direct-github-api-and-mirror-pipeline.md)
- [ADR-0003: 嵌入式 SQLite 持久化与 ETag 条件请求缓存](docs/adr/0003-sqlite-persistence-and-etag-caching.md)
- [ADR-0004: 流式安装引擎与零信任 SHA-256 / Authenticode 验签防篡改](docs/adr/0004-streaming-installer-and-checksum-verification.md)
- [ADR-0005: 跨平台多模式应用图标自适应架构规范](docs/adr/0005-cross-platform-multi-mode-icon-specifications.md)
- [ADR-0006: 多源代码托管平台 (Multi-Forge) 生态支持与统一抽象层](docs/adr/0006-multi-forge-ecosystem-support.md)
- [ADR-0007: 开源清单仓库动态同步与客户端按需 API 详情拉取（含可配置 TTL 缓存）](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)
- [ADR-0008: 出站代理与 OAuth 加固及设置中心重构](docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md)
- [ADR-0009: 应用市场生态清单仓库与客户端运行时引擎解耦](docs/adr/0009-catalog-manifest-repository-decoupling.md)
- [全局决策与执行边界规范 (Decision Protocol)](.agents/rules/decision-protocol.md)

---

## 📄 许可协议

本项目基于 MIT / Apache-2.0 双开源协议分发，详见 LICENSE。

---

## 📝 文档变更与历史演进备注

> 本节记录系统历史技术方案演进与本次文档更新说明，供追溯与参考；文档正文仅保持对系统当前最新实现机制的客观记录。

1. **应用市场清单仓库解耦演进 (ADR-0009)**：
   - *过去做法*：在早期阶段，`catalog.json` 存放在客户端代码主仓库中，并通过 GitHub Actions 定时任务机器人拉取并提交更新，导致客户端 Git Commit 历史充斥大量自动化提交，且社区贡献应用必须直接向核心客户端提 PR。
   - *当前现状*：生态数据已完整剥离至独立的 `superMC5657/z-store-catalog` 仓库独立维护，主仓库根目录仅保留打包时的种子清单作为离线兜底，客户端 CI 工作流完全净化。
2. **侧栏底部常驻胶囊组件演进**：
   - *过去做法*：早期侧栏底部 `network-pill` 用于展示加速镜像节点的延迟测试信息。
   - *当前现状*：镜像测速与线路切换已规范收归至设置中心；侧栏底部统一变更为 GitHub 账号入口胶囊（`Account Capsule`），用于展示登录态或快捷唤起设备码认证，实现与 GitHub Star 同步等生态特性的直观联动。
3. **应用标识符与平台筛选模型升级**：
   - *过去做法*：应用清单早期仅包含扁平的 `executables: string[]` 数组，且分类浏览页仅支持单一功能分类筛选。
   - *当前现状*：数据模型重构升级为 `identifiers: Record<string, string[]>` 字典，分别映射 Windows、Linux、macOS、Android、iOS 各端的原生可执行文件名或应用包名；分类浏览页全面升级为设备平台与功能分类双维交叉筛选。
4. **项目超参及配置中心化治理**：
   - *过去做法*：网络超时、历史记录上限、默认 Client ID 及清单路径等超参分散硬编码在 Rust 模块及部分辅助脚本中。
   - *当前现状*：全量收归至 `src-tauri/config.toml` 单一配置源，Rust 端通过 `ProjectConfig` 提供强类型只读引用并内嵌编译期默认值。
