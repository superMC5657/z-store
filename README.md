# Z-Store

> 基于 GitHub / Multi-Forge Releases 的跨平台开源应用商店 · 深度融合 Windows 11 Fluent Design 2.0

![Z-Store License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.2-blue?logo=tauri)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)

---

## 🌟 项目定位与基石原则 (Core Principles)

**Z-Store 致力于成为开源世界的系统级应用商店**，把 GitHub 及主流开源托管平台的 Releases 转化为人人可用、一键安装、自动更新的跨平台现代化应用商店。

本项目严格遵循四大基石原则：

- **D1 纯粹开源 (Strictly FLOSS)**: 仅收录和分发具备 OSI 认证开源协议的软件项目，杜绝商业广告、捆绑流氓软件与闭源专有推广。
- **D2 零服务器成本与解耦清单同步 (Serverless & Decoupled Manifest Sync)**:
  - 基于独立的开源清单仓库（[superMC5657/z-store-catalog](https://github.com/superMC5657/z-store-catalog)）增量同步精选应用元数据，客户端本地预置 `catalog.json` 离线种子兜底，保障断网或首发秒开（详见 [ADR-0009](docs/adr/0009-catalog-manifest-repository-decoupling.md)）；
  - 客户端通过 `ForgeProvider` 抽象层**按需直连**托管平台官方 REST API 获取深度详情与构建资产，无需中心化专有后端；
  - 本地 SQLite 持久化结合统一配置源（`src-tauri/config.toml`）的 TTL 缓存（默认 30 分钟）与 **HTTP ETag 304 条件重新验证**，实现零 API 配额消耗延长时效与离线平滑降级（详见 [ADR-0007](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)）。
- **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
  - 默认利用高可用加速镜像代理大文件下载；
  - 下载后**强制流式计算 SHA-256 哈希**并与官方清单比对，哈希不符立即强行阻断并销毁临时文件，防御供应链投毒（详见 [ADR-0004](docs/adr/0004-streaming-installer-and-checksum-verification.md)）。
- **D4 Linear 去彩单色界面 (Monochrome Design System)**:
  - 全站采用 Linear 风格的去彩单色体系：原生黑白灰画布、hairline 微边框、6/8px 精密圆角、510/590 字重与负字距，配 100~200ms snappy 微动效与系统级深浅色自适应；
  - 全站功能操作与状态反馈全面采用统一的线性矢量图标体系（基于 `lucide-react` 14px/stroke 1.5 与统一单色矢量 SVG，通过 `currentColor` 适配主题与微动效）；
  - 配套 [ADR-0005](docs/adr/0005-cross-platform-multi-mode-icon-specifications.md) 明暗双模标识体系（暗夜实底 `#08090A` / 明亮实底 `#FFFFFF`）。

---

## 🚀 核心功能与特色 (Key Features)

### 1. 🌐 解耦清单同步与按需详情获取
- **离线秒开与种子兜底**：客户端启动优先读取本地 `catalog.json` 种子清单，保证零网络延迟立即可用。
- **一键动态同步**：设置中心支持随时“立即同步收录库”，增量拉取独立生态仓库最新清单，支持配置自定义同步源与加速前缀。
- **TTL 智能缓存与 ETag 续期**：统一基线缓存 TTL（默认 30 分钟），过期后触发 ETag 304 条件请求，零配额消耗延长缓存新鲜度；该 TTL 仅约束详情浏览，更新发现（更新中心/关注动态）每次走 ETag 轻量探查，不受其约束。
- **发现流分页与搜索翻页**：发现 Feed 首屏 20、触底续 20 无限滑（`has_more=(offset+limit)<total`）；在线搜索默认 `per_page=12`、钳制 1–50，满页即 `hasMore` 续拉下一页。
- **首页排序锁定**：首页固定 `balanced + seed 7`，无排序切换工具条。

### 2. 🦊 多托管平台与多设备平台双维筛选
- **多托管源抽象**：`ForgeProvider` 统一抽象层原生支持 **GitHub**、**Codeberg**、**GitLab**、**Forgejo** 与自建 **Gitea** 实例（[ADR-0006](docs/adr/0006-multi-forge-ecosystem-support.md)），跨平台统一仓库标识（`gh:`、`cb:`、`gl:`、`gitea:`），支持独立主机 PAT 与速率管理。
- **原生多端标识符结构**：元数据清单原生支持按操作系统划分的应用标识符体系（`identifiers`：Windows 进程/可执行文件名、Linux 进程名、macOS 应用名、Android/iOS 原生包名）。
- **双维交叉筛选**：分类中心支持按设备平台（全部设备 / Windows / Android / macOS / Linux / iOS）与功能分类（系统实用、开发工具、影音视听等 10 大分类）实时双维交叉过滤。

### 3. 🔍 存量已安装应用外部导入与管理 (External App Management)
- 深度扫描 Windows 系统已安装软件（注册表 `Uninstall` 项与系统目录），提取软件名称、版本与安装路径。
- 基于倒排索引与启发式置信度打分算法（支持别名匹配与特征指纹），智能识别本地已装的开源软件（如 VLC、OBS、VS Code、Git 等），一键导入管理并接管自动更新。

### 4. 🛡️ 细粒度版本控制与安全防御
- **版本控制中枢**：更新列表中可针对特定应用选择“跳过此版本”或“锁定当前版本（禁止自动更新）”，避免破坏性升级；版本新旧比较遵循 semver 语义。
- **黑名单管理**：支持从推荐与搜索列表中隐藏不感兴趣的应用仓库。
- **SHA-256 完整性校验**：下载后强制流式计算 SHA-256 并与官方清单比对，不符立即阻断；本地已存在且哈希命中即零网络跳过（未命中/无期望哈希才重下覆盖，而非必重下）。
- **便携卸载隔离**：`remove_dir_all` 仅允许删除 Z-Store 自建的隔离目录，共享目录只做安全清理。

### 5. 🌟 开发者全景生态与 GitHub Star 同步
- **开发者主页**：点击作者一键查看其名下所有的开源项目、开源许可协议与最新发布历史。
- **GitHub OAuth 登录**：Device Flow 免应用密钥登录，Client ID 遵循单一配置源（`src-tauri/config.toml`），支持在设置项中自定义覆盖。采用 `classify_device_poll` 明确区分 `Expired` 与 `Denied` 状态。
- **GitHub Star 导入**：登录后一键拉取个人 Star 列表中所有具备可用构建资产的开源项目。
- **本地足迹追踪**：自动记录并持久化搜索历史与最近浏览应用，支持一键快捷回访。
- **趋势榜单直取**：经共享 Client 直取（`tokio` 10s 超时，截断 2MB 防爆内存），仅允许 `github.com` / `trend.doforce.dpdns.org` / `api.github.com` 三 host 白名单；doforce 429 仅按 `Retry-After` 再试一次（上限 60s，缺省等 5s）。

### 6. 🔄 检查更新流式推流与实时感知
- **实时推流动效**：更新检查基于并发管道流式拉取（`buffer_unordered(6)`，主路径与关注通知两处），后端通过 `zstore://update-check-progress` 逐项推流，前端呈现丝滑进度条与更新项逐项跳出微动效。
- **轻量版本嗅探**：更新检查仅拉取版本号与 Release 说明，结合 ETag 304 极速响应，不下载大体积 README 或非必要元数据；与详情 30 分钟 TTL 解耦，每次 ETag 轻探查（304 零配额延长保鲜）。

### 7. 🔗 系统级协议与状态指示
- **深层链接唤起**：注册 `zstore://` URL Scheme，支持浏览器与外部命令行直接唤起客户端直达详情、安装或搜索；安装类深链必须经过显式确认对话框，用户点确认后才开始安装。
- **API 速率感知**：后台动态感知 GitHub 剩余调用配额，收敛于账号卡片按需查看与管理。
- **GitHub 账号胶囊**：侧栏底部常驻账号入口（`Account Capsule`），未登录状态下展示登录入口，登录后展示用户头像与用户名，点击直达设置中心账号卡片。

### 8. 🌐 网络代理与下载加速架构
- **下载加速代理**：针对 Release 二进制大文件下载拼接加速前缀（默认 `https://gh-proxy.com`），支持在设置中心配置与单键测速。
- **系统代理与 TUN 截获**：客户端发出的 HTTP 请求天然受系统代理及本地代理工具（如 Clash / v2ray / TUN 模式）透明捕获，无需在应用内繁琐配置本地代理 IP/端口；Windows 启动时自探测注册表系统代理无缝衔接。

### 9. ⚙️ 设置中心 5 组架构
- 设置中心规范分为 5 个业务分组：`🖥️ 外观与显示`、`🔄 更新与提醒`、`📁 存储与下载`、`🌐 账号与网络`、`💾 数据备份`。
- 全量项目超参与默认配置收敛于 `src-tauri/config.toml` 单一真相源，确保前后端与引擎默认行为严格对齐。
- **数据备份范围**：备份覆盖 12 个设置字段，`github_token`（PAT 凭据）刻意排除，永不经备份文件流转。
- **更新频率选项**：支持“启动时检测”与“仅手动检查”。
- **自定义清单源**：填写非官方同步源属于破坏性替换，需经过显式二次确认；留空即恢复官方默认流程。

---

## 🛠️ 架构与技术栈

- **桌面底座**: Tauri 2.2 + Rust 1.77+
- **前端界面**: React 19 + TypeScript 5.7 (strict) + Vite 6 + 原生 Fluent 2.0 CSS + Fluent 矢量图标体系 (`lucide-react`)
- **本地数据库**: 嵌入式 SQLite (`rusqlite` bundled，WAL 模式，维护 15 张核心表：含 `trend_board_cache` 与 `search_result_cache`（趋势榜与搜索结果L2缓存），`icon_cache_meta` 与 `app_icon_cycles`，图标缓存来源与轮换状态分流）
- **配置中枢**: 单一基线配置源（`src-tauri/config.toml`），结合编译期内置兜底与外部重载机制
- **网络与下载**: API / 图标双池物理隔离复用单例（均 `connect_timeout 5s`、`keepalive 60s`、`pool 20/idle 90s`；图标 CDN 通道恒丢 token，绝不携带认证头）+ `tokio` 异步流式下载 + ETag 条件缓存 + 有限重试（仅 GET 传输错误与 429/5xx，最多 2 次按 200ms→800ms 退避，401/404/304 永不重试）+ 并发镜像测速管道；图标先 HEAD 判类型长度、再 Range 取前 32KB 验 magic（300B 最小阈值卡掉 LFS 指针，`buffered(3)` 并发）；自动继承系统代理与 TUN 模式
- **桌面开发配置**: `pnpm tauri dev`（基于 `src-tauri/tauri.conf.json` 配置本地安全策略）
- **安装引擎**: Windows MSI (`/qn`)、Setup EXE (`/S` / `/VERYSILENT`)、便携版 ZIP/tarball 自动解压与快捷方式生成（便携 ZIP/tarball（.zip + 二进制 .tar.gz/.tgz/.tar.xz/.tar，os+arch命中可装、仅本平台、tar权重+5垫底、剥顶层+chmod兜底；.7z/.tar.bz2只下载））、macOS (DMG/PKG) 及 Linux (deb/rpm/AppImage) 管道；Unix 卸载走 argv 直调，不经 `sh -c`

---

## 📊 开发里程碑与功能交付现状

| 阶段 / 功能模块 | 规划定位 | 当前状态 | 核心成果与支撑规范 |
|---|---|---|---|
| **M0: 核心基座与 MVP** | 基础架构与 Windows 端闭环 | **100% 已交付** | 纯客户端直连、Fluent 2 亚克力界面、国内镜像加速管道 |
| **Feature A: 多代码托管平台** | Codeberg / Forgejo / Gitea | **100% 已交付** | `ForgeProvider` 抽象、多主机 Token 隔离 ([ADR-0006](docs/adr/0006-multi-forge-ecosystem-support.md)) |
| **Feature B: 存量应用管理** | 扫描已装软件并接管更新 | **100% 已交付** | Windows 注册表扫描器、启发式倒排打分匹配引擎 |
| **Feature C: 版本控制与验签** | 跳过/锁定版本 | **100% 已交付** | SQLite 版本规则表、SHA-256 流式校验 ([ADR-0004](docs/adr/0004-streaming-installer-and-checksum-verification.md)) |
| **Feature D: 开发者生态** | 开发者全景与 Star 仓库同步 | **100% 已交付** | 开发者主页、GitHub Star 导入、搜索/浏览历史持久化 |
| **Feature E: 协议唤起与多端** | `zstore://` 路由与多端管道 | **100% 已交付** | URL Scheme 深度链接、API 配额药丸胶囊、类 Unix 安装管道 |
| **ADR-0007: 开放清单与缓存** | 开放清单同步 + 固定基线 TTL | **100% 已交付** | 远程 Manifest 仓库动态拉取、统一 30 分钟基线 TTL、ETag 304 零配额续期 |
| **ADR-0008: 出站代理与设置重构** | 出站代理 + OAuth 加固 + 设置 5 组 | **100% 已交付** | 系统代理透明捕获、OAuth 三级 Client ID、独立状态机、设置 5 组规范 ([ADR-0008](docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md)) |
| **ADR-0009: 清单解耦与多端体系** | 独立生态仓库 + 多端 Identifiers | **100% 已交付** | 解耦至 `superMC5657/z-store-catalog`、原生多端标识符结构、设备与分类双维筛选、单一配置源 ([ADR-0009](docs/adr/0009-catalog-manifest-repository-decoupling.md)) |
| **ADR-0010: 规范应用标识** | canonical id 全链路统一 | **100% 已交付** | 小写 `owner/repo` 全局唯一标识、入口统一归一化、纯粹单键索引 ([ADR-0010](docs/adr/0010-canonical-app-identifier.md)) |
| **合并审查 28 项整改 (4938964)** | 安全加固与测试台补齐 | **100% 已交付** | 深链安装二次确认、便携卸载目录白名单、semver 版本比较、去 `.7z` 宣称、tar.gz大修：二进制tarball可展示可装、`.tar.bz2`/`.7z`只下载；前后端自动化测试全量通过（计数以 `cargo test` / `pnpm test` 实际运行结果为准） |
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

# 2. 运行自动化测试与前端类型检查（通过计数以实际运行输出为准）
cargo test
pnpm test
pnpm build

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

## 📄 架构决策记录 (ADR) 与核心文档

- [ADR-0001: 采用 Tauri 2 与 React 19 + Fluent 2.0 架构](docs/adr/0001-tauri2-and-react-fluent-architecture.md)
- [ADR-0002: 客户端直连 GitHub API 与加速镜像下载管道](docs/adr/0002-direct-github-api-and-mirror-pipeline.md)
- [ADR-0003: 嵌入式 SQLite 持久化与 ETag 条件请求缓存](docs/adr/0003-sqlite-persistence-and-etag-caching.md)
- [ADR-0004: 流式安装引擎与零信任 SHA-256 完整性校验](docs/adr/0004-streaming-installer-and-checksum-verification.md)
- [ADR-0005: 跨平台多模式应用图标自适应架构规范](docs/adr/0005-cross-platform-multi-mode-icon-specifications.md)
- [ADR-0006: 多源代码托管平台 (Multi-Forge) 生态支持与统一抽象层](docs/adr/0006-multi-forge-ecosystem-support.md)
- [ADR-0007: 开源清单仓库动态同步与客户端按需 API 详情拉取（含可配置 TTL 缓存）](docs/adr/0007-open-manifest-catalog-and-configurable-ttl-cache.md)
- [ADR-0008: 出站代理与 OAuth 加固及设置中心重构](docs/adr/0008-outbound-proxy-oauth-hardening-and-settings-restructure.md)
- [ADR-0009: 独立生态清单仓库与客户端运行时引擎解耦](docs/adr/0009-catalog-manifest-repository-decoupling.md)
- [ADR-0010: 规范应用标识（Canonical App Identifier）](docs/adr/0010-canonical-app-identifier.md)
- [ADR-0011: doforce趋势聚合源例外](docs/adr/0011-doforce-trends-aggregator-exception.md)
- [ADR-0012: 网络性能P0双池并发跳过](docs/adr/0012-network-perf-p0-pooling-concurrency-skip.md)
- [ADR-0013: Feed契约](docs/adr/0013-feed-contract.md)
- [协作规范与 Agent 指南](AGENTS.md)

---

## 📄 许可协议

本项目基于 MIT / Apache-2.0 双开源协议分发，详见 LICENSE。


