# Z-Store

> 基于 GitHub / Multi-Forge Releases 的跨平台开源应用商店 · 深度融合 Windows 11 Fluent Design 2.0

![Z-Store License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.2-blue?logo=tauri)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)

---

## 🌟 项目定位与基石原则 (Core Principles)

**Z-Store 致力于成为开源世界的系统级应用商店**——把 GitHub 及主流开源托管平台的 Releases 转化为人人可用、一键安装、自动更新的跨平台现代化应用市场。

本项目严格遵循四大基石原则：

- **D1 纯粹开源 (Strictly FLOSS)**: 仅收录和分发具备 OSI 认证开源协议的软件项目，杜绝商业广告、捆绑流氓软件与闭源专有推广。
- **D2 零服务器成本与开放清单同步 (Serverless & Open Manifest Sync)**:
  - 基于公开维护的开源清单仓库（Open Manifest Catalog Repository）增量同步精选应用元数据；
  - 客户端通过 `ForgeProvider` 抽象层**按需直连**托管平台官方 REST API 获取深度详情与构建资产，无需中心化专有后端；
  - 本地 SQLite 持久化结合用户**可配置 TTL 缓存**（0~1440 分钟，默认 30 分钟）与 **HTTP ETag 304 条件重新验证**，实现零 API 配额消耗延长时效与离线平滑降级（详见 [ADR-0007](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)）。
- **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
  - 默认利用中国大陆高可用加速镜像代理大文件下载；
  - 下载后**强制流式计算 SHA-256 哈希**并与官方清单比对，哈希不符立即强行阻断并销毁临时文件；
  - Windows 端结合 Authenticode 数字证书指纹提取与有效性强核验，防御供应链投毒（详见 [ADR-0004](docs/adr/0004-windows-authenticode-signature-verification.md)）。
- **D4 深度融合 Fluent Design 2.0 (Native Design System)**:
  - 全面遵循微软 Windows 11 Fluent 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射高光描边、平滑微动效与系统级深浅色自适应（`light-dark()`、`in oklch`）；
  - 配套 [ADR-0005](docs/adr/0005-adaptive-icon-system.md) 晶透双模标识体系。

---

## 🚀 核心功能与特色 (Key Features)

### 1. 🌐 开放收录清单同步与按需详情获取
- **轻量清单秒开**：客户端启动极速载入精选收录库（包含分类、图标、中文别称、仓库地址），永不因网络阻滞列表浏览。
- **一键动态同步**：设置中心支持随时“立即同步收录库”，增量更新远端收录仓库的最新应用清单，并自动回退本地内置清单。
- **TTL 智能缓存**：支持用户自定义应用详情缓存生命周期（实时/30分钟/1小时/6小时/24小时），搭配 ETag 304 零配额刷新。

### 2. 🦊 多代码托管平台支持 (Multi-Forge Support)
- 抽象统一的 `ForgeProvider` 核心，原生支持 **GitHub**、**Codeberg**、**Forgejo** 与自建 **Gitea** 实例（[ADR-0006](docs/adr/0006-multi-forge-provider-architecture.md)）。
- 跨托管平台统一仓库标识（`gh:owner/repo`、`cb:owner/repo`、`gitea:host:owner/repo`），支持独立 PAT 安全管理与速率感知。

### 3. 🔍 存量已安装应用外部导入 (External App Import)
- 深度扫描 Windows 系统已安装软件（注册表 `Uninstall` 项与系统目录），提取软件名称、版本与安装路径。
- 基于倒排索引与启发式置信度打分算法（支持别名匹配与特征指纹），智能识别本地已装的开源软件（如 VLC、OBS、VS Code、Git 等），一键接管自动更新。

### 4. 🛡️ 细粒度版本控制与安全防御
- **版本控制中枢**：更新列表中可针对特定应用选择“跳过此版本”或“锁定当前版本（禁止自动更新）”，避免破坏性升级。
- **黑名单管理**：支持从推荐与搜索列表中隐藏不感兴趣的应用仓库。
- **Authenticode 验签**：Windows 平台自动检测并展示安装包的数字签名状态、签名者组织与证书 SHA-256 指纹。

### 5. 🌟 开发者全景生态与 GitHub Star 同步
- **开发者主页**：点击作者一键查看其名下所有的开源项目、开源许可协议与最新发布历史。
- **GitHub Star 导入**：授权后一键拉取个人 Star 列表中所有具备可用构建资产的开源项目。
- **本地历史追踪**：自动记录并持久化搜索历史与最近浏览应用，支持一键快捷回访。

### 6. 🔗 系统级协议与状态指示
- 注册 `zstore://` URL Scheme，支持外部链接与浏览器一键拉起客户端并直达应用详情或触发安装。
- 视窗右下角常驻 API 速率指示器胶囊（Rate Limit Pill），动态告警剩余配额；并提供多镜像节点延迟状态监测。

---

## 🛠️ 架构与技术栈

- **桌面底座**: Tauri 2.2 + Rust 1.77+
- **前端界面**: React 19 + TypeScript 5.7 + Vite 6 + 原生 Fluent 2.0 CSS
- **本地数据库**: 嵌入式 SQLite (`rusqlite` bundled)
- **网络与下载**: `reqwest` (stream) + ETag 条件缓存 + 并发镜像测速管道
- **安装引擎**: Windows MSI (`/qn`)、Setup EXE (`/S` / `/VERYSILENT`)、便携版 ZIP 自动解压与快捷方式生成、macOS (DMG/PKG) 及 Linux (deb/rpm/AppImage) 管道

---

## 📊 开发里程碑与功能交付现状

| 阶段 / 功能模块 | 规划定位 | 当前状态 | 核心成果与支撑规范 |
|---|---|---|---|
| **M0: 核心基座与 MVP** | 基础架构与 Windows 端闭环 | **100% 已交付** | 纯客户端直连、Fluent 2 亚克力界面、国内镜像加速管道 |
| **Feature A: 多代码托管平台** | Codeberg / Forgejo / Gitea | **100% 已交付** | `ForgeProvider` 抽象、多主机 Token 隔离 ([ADR-0006](docs/adr/0006-multi-forge-provider-architecture.md)) |
| **Feature B: 存量应用纳管** | 扫描已装软件并接管更新 | **100% 已交付** | Windows 注册表扫描器、启发式倒排打分匹配引擎 |
| **Feature C: 版本控制与验签** | 跳过/锁定版本与证书核验 | **100% 已交付** | SQLite 版本规则表、Windows Authenticode 签名核验 ([ADR-0004](docs/adr/0004-windows-authenticode-signature-verification.md)) |
| **Feature D: 开发者生态** | 开发者全景与 Star 仓库同步 | **100% 已交付** | 开发者主页、GitHub Star 导入、搜索/浏览历史持久化 |
| **Feature E: 协议唤起与多端** | `zstore://` 路由与多端管道 | **100% 已交付** | URL Scheme 深度链接、API 配额药丸胶囊、类 Unix 安装管道 |
| **ADR-0007: 开放清单与缓存** | 开放清单同步 + 可配 TTL | **100% 已交付** | 远程 Manifest 仓库动态拉取、0~1440m TTL、ETag 304 零配额续期 |
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

# 2. 运行自动化测试
cargo test
pnpm typecheck

# 3. 启动前端浏览器开发预览
pnpm dev

# 4. 启动 Tauri 桌面完整应用
pnpm tauri dev
```

### 构建打包

```bash
# 构建 Windows 安装包 (NSIS)
pnpm tauri build
```

---

## 📄 架构决策记录 (ADR)

- [ADR-0001: 统一代码与文档协作决策协议](docs/adr/0001-decision-protocol-and-execution-boundaries.md)
- [ADR-0004: Windows Authenticode 签名核验引擎](docs/adr/0004-windows-authenticode-signature-verification.md)
- [ADR-0005: 晶透双模系统级图标标识体系](docs/adr/0005-adaptive-icon-system.md)
- [ADR-0006: 多代码托管平台抽象架构 (ForgeProvider)](docs/adr/0006-multi-forge-provider-architecture.md)
- [ADR-0007: 开放收录清单同步与可配置 TTL 缓存](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)

---

## 📄 许可协议

本项目基于 MIT / Apache-2.0 双开源协议分发，详见 LICENSE。
