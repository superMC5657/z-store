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
- **D2 零服务器成本与开放清单同步 (Serverless & Open Manifest Sync)**:
  - 基于公开维护的开源清单仓库（Open Manifest Catalog Repository）增量同步精选应用元数据；
  - 客户端通过 `ForgeProvider` 抽象层**按需直连**托管平台官方 REST API 获取深度详情与构建资产，无需中心化专有后端；
  - 本地 SQLite 持久化结合用户**可配置 TTL 缓存**（0~1440 分钟，默认 30 分钟）与 **HTTP ETag 304 条件重新验证**，实现零 API 配额消耗延长时效与离线平滑降级（详见 [ADR-0007](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)）。
- **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
  - 默认利用中国大陆高可用加速镜像代理大文件下载；
  - 下载后**强制流式计算 SHA-256 哈希**并与官方清单比对，哈希不符立即强行阻断并销毁临时文件；
  - Windows 端结合 Authenticode 数字证书指纹提取与有效性强核验，防御供应链投毒（详见 [ADR-0004](docs/adr/0004-streaming-installer-and-checksum-verification.md)）。
- **D4 深度融合 Fluent Design 2.0 (Native Design System)**:
  - 全面遵循微软 Windows 11 Fluent 2.0 规范，提供亚克力毛玻璃 (Acrylic)、折射高光描边、平滑微动效与系统级深浅色自适应（`light-dark()`、`in oklch`）；
  - 配套 [ADR-0005](docs/adr/0005-cross-platform-multi-mode-icon-specifications.md) 晶透双模标识体系。

---

## 🚀 核心功能与特色 (Key Features)

### 1. 🌐 开放收录清单同步与按需详情获取
- **轻量清单秒开**：客户端启动极速载入精选收录库（包含分类、图标、中文别称、仓库地址），永不因网络阻滞列表浏览。
- **一键动态同步**：设置中心支持随时“立即同步收录库”，增量更新远端收录仓库的最新应用清单，并自动回退本地内置清单。
- **TTL 智能缓存**：支持用户自定义应用详情缓存生命周期（实时/30分钟/1小时/6小时/24小时），搭配 ETag 304 零配额刷新。

### 2. 🦊 多代码托管平台支持 (Multi-Forge Support)
- 抽象统一的 `ForgeProvider` 核心，原生支持 **GitHub**、**Codeberg**、**Forgejo** 与自建 **Gitea** 实例（[ADR-0006](docs/adr/0006-multi-forge-ecosystem-support.md)）。
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
- **GitHub OAuth 登录**：Device Flow 免应用密钥登录，Client ID 三级优先级为设置项 `github_oauth_client_id` ＞ 编译期环境变量 `ZSTORE_GITHUB_OAUTH_CLIENT_ID` ＞ 内置默认 `Ov23lik0b7fDGMLTiOYH`。命中占位 `YOUR_CLIENT_ID_HERE` 视为未配置，无法发起登录。scope 仅申请 `public_repo`，令牌只存本地 SQLite（`user_settings.github_oauth_token`）。
- **轮询状态机**：后端 `classify_device_poll` 明确区分 `Expired` 与 `Denied` 独立状态，前端分别提示。登录成功自动拉起浏览器授权页（`api.openUrl`），网络抖动不中断会话，连续 10 次失败才停止轮询并保留用户码展示。
- **GitHub Star 导入**：登录后一键拉取个人 Star 列表中所有具备可用构建资产的开源项目。
- **本地历史追踪**：自动记录并持久化搜索历史与最近浏览应用，支持一键快捷回访。

### 6. 🔗 系统级协议与状态指示
- 注册 `zstore://` URL Scheme，支持外部链接与浏览器一键拉起客户端并直达应用详情或触发安装。
- 视窗右下角常驻 API 速率指示器胶囊（Rate Limit Pill），动态告警剩余配额；并提供多加速镜像节点延迟状态监测。
- 侧栏底部为 GitHub 登录胶囊（`Sidebar` 内 `network-pill` 按钮，点击经 `App` 的 `handleOpenAccountSettings` 跳转设置页 `#settings-account` 锚点），取代旧镜像胶囊。未登录显示“GitHub 登录”，已登录显示头像与用户名。

### 7. 🌐 出站代理与下载加速代理的区分
- **下载加速代理**：只给安装包下载拼接前缀（如 `https://gh-proxy.com`），在设置中心加速节点多胶囊中切换，配 `⚡ 测速` 按钮探测延迟。
- **出站代理**：登录与托管源提供者 API 直连共用，走系统代理或自填代理。设置键为 `http_proxy_url`（常量 `FORWARD_PROXY_SETTING`），命令为 `set_forward_proxy`（校验、落库、即时生效，空串清空）与 `test_forward_proxy`（经代理 GET `https://api.github.com/rate_limit`，8 秒超时，返回连通性与延迟）。前端对应 `api.setForwardProxy` 与 `api.testForwardProxy`。
- **校验规则**：接受 `host:port`、`http(s)://host:port`、`socks5(h)://host:port`（含 `socks4` / `socks4a`），空输入回退系统代理或直连。非法协议、缺主机名、缺端口直接返回原因。依赖 `reqwest` 的 `socks` 特性。
- **何时填写**：只有 `github.com` 连不通（如登录轮询失败）时才需要填写出站代理，保存即时生效，无需重启。

### 8. ⚙️ 设置中心 5 组结构
- 设置中心共 5 组：`🖥️ 外观与显示`、`🔄 更新与提醒`、`👤 GitHub 账号与配额`、`🌐 网络与清单数据`、`💾 数据备份与恢复`。
- `👤 GitHub 账号与配额`内含 `OAuthAccountCard` 登录卡片（`#settings-account` 锚点）与 PAT 令牌行，匿名 60 次/小时，令牌或登录后 5000 次/小时。
- `🌐 网络与清单数据`内含加速节点多胶囊切换加测速、下载加速代理行、出站代理行、精选收录库同步行、应用详情 TTL 行。

---

## 🛠️ 架构与技术栈

- **桌面底座**: Tauri 2.2 + Rust 1.77+
- **前端界面**: React 19 + TypeScript 5.7 + Vite 6 + 原生 Fluent 2.0 CSS
- **本地数据库**: 嵌入式 SQLite (`rusqlite` bundled)
- **网络与下载**: `reqwest`（`json` / `stream` / `socks` 特性）+ ETag 条件缓存 + 并发镜像测速管道；出站代理经 `http_proxy_url` 即时生效
- **桌面开发配置**: `pnpm tauri:dev`（即 `tauri dev --config src-tauri/tauri.dev.conf.json`）覆盖 CSP，支持本地 `http://localhost:1420` 与 `ws://localhost:1421` 调试
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
| **ADR-0008: 出站代理与设置重构** | 出站代理 + OAuth 加固 + 设置 5 组 | **100% 已交付** | `http_proxy_url` 出站代理、OAuth 三级 Client ID、Expired/Denied 独立状态、登录胶囊、加速节点测速 ([ADR-0008](docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md)) |
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

# 4. 启动 Tauri 桌面完整应用（使用 dev 专用 CSP 配置，
#    即 tauri dev --config src-tauri/tauri.dev.conf.json）
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
- [全局决策与执行边界规范 (Decision Protocol)](.agents/rules/decision-protocol.md)
- [商业化战略、生态变现与低频破局白皮书](docs/商业化战略与低频破局思考.md)
- [竞品功能深度剖析与下一代演进 Roadmap](docs/竞品分析与下一代Roadmap.md)
- [跨平台多模式图标规范与开发指引](docs/跨平台图标规范与开发指南.md)
- [Android 端 Shizuku 免 Root 静默安装预研](docs/android-shizuku-research.md)

---

## 📄 许可协议

本项目基于 MIT / Apache-2.0 双开源协议分发，详见 LICENSE。
