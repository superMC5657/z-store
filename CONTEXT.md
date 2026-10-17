# CONTEXT.md: ZStore 领域模型与核心契约

本项目为 **ZStore**，一个基于 **Tauri 2 + Rust + React 19** 构建的轻量级跨平台开源应用商店（界面以 Linear 去彩单色为主，Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。

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
| **构建资产** | `ReleaseAsset` | Release 附带的编译产物二进制包（如 `.msi`、`.exe`、`.zip`、`.tar.gz`/`.tgz`/`.tar.xz`/`.tar`、`.deb`、`.dmg`、`.apk`，其中 `.7z`/`.tar.bz2`为Download-Only），带有平台架构分类。 | 附件、下载包、安装文件 |
| **托管源提供者** | `ForgeProvider` | 统一源代码托管抽象层，原生支持 GitHub、Codeberg、Gitea、GitLab 等开源代码源。详见 ADR-0006。 | 仓库源、平台接口 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理文件下载与 API 的反代节点（如 `gh-proxy.com`），支持动态测速与透明重写。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 ZStore 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测。 | 本地缓存、HTTP缓存 |
| **清单同步** | `Manifest Catalog Sync` | 客户端从独立开源收录仓库动态拉取或增量刷新应用元数据清单的机制，详见 ADR-0007 与 ADR-0009。 | 清单下载、列表更新 |
| **缓存生存时效** | `Cache TTL` | 客户端本地持久化详情的有效周期（基线 60 分钟；设置页不暴露；后端对改库/导入值按挡位 `[0, 10, 60, 360, 1440]` 归一化，非法值回退 60），过期后触发带 ETag 的条件重新验证；仅约束详情浏览：非资产面（搜索/趋势/平台推导/图标/首页）默认自动拉取并经 ETag 条件请求复用，资产面（已安装应用、更新中心、收藏）仅手动触发网络——更新中心列表为手动快照（仅显式刷新写 `update_results`，其余读库），收藏/关注凭记录自带收录标记就近读卡。 | 缓存过期时间、过期策略 |
| **应用内仅下载** | `Download-Only` | 宿主不可安装的资产经应用内通道下载落盘、不调用安装器的模式，复用安装通道的镜像改写、SHA-256 校验与下载进度事件，落盘后可一键定位文件。 | 浏览器下载、直链下载 |
| **便携版应用** | `Portable App` | 免安装 ZIP/二进制tarball，剥顶层解压至AppData、Linux/macOS chmod兜底，仅本平台可装，自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式 (D-轻1 冰川浅蓝) 与暗黑模式 (D-轻4 晶透亚克力) 的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |
| **协议深层链接** | `Deep Linking` | 注册系统级 `zstore://` URL Scheme，支持浏览器与外部链接一键呼起客户端直达详情、安装或搜索路由。 | 外部协议、跳转链接 |
| **版本控制规则** | `Update Rule` | 持久化于本地 SQLite 的应用更新策略，支持跳过指定破坏性版本、永久锁定版本与隐藏特定仓库。 | 忽略更新、锁定版本 |
| **SHA-256 完整性校验** | `Checksum Verification` | 下载后强制 SHA-256 流式校验，与 `checksums.txt` / `SHA256SUMS` 比对（详见 ADR-0004）。 | Authenticode、证书校验、安全验签 |
| **存量应用管理** | `External App Management` | 扫描操作系统已安装软件（Windows 注册表及程序目录），通过倒排索引与启发式打分智能匹配开源清单，一键添加至管理列表并接管更新。 | 软件扫描、外部导入、应用纳管 |
| **Fluent 2 矢量图标体系** | `Fluent Vector Icon System` | 全站功能操作、导航菜单、设备平台标识及状态指示全面采用轻量线性矢量图标（`lucide-react` 与统一单色 SVG），严格遵循 Fluent 2.0 视觉规范与 `currentColor` 主题自适应，配合 CSS 微动效与状态指示原点。 | 功能Emoji、彩色贴图、图标库 |
| **主机配额指示器** | `Host Quota Indicator` | 各托管平台 API 调用配额监听与告警机制（配额监听与告警收敛于账号卡片按需管理）。 | 配额胶囊、限流状态 |
| **下载加速代理** | `Mirror Download Proxy` | 仅用于大文件下载提速的加速镜像节点重写（如 `gh-proxy.com`）；仅改变下载 URL 前缀，API 与登录直接走系统网络通道。 | 出站代理、镜像节点 |
| **GitHub登录胶囊** | `Account Capsule` | 侧栏底部常驻账号入口：未登录显示 GitHub 快捷登录入口，已登录显示用户头像与用户名；点击直达设置中心账号卡片（`#settings-account`）。 | 侧边栏按钮、用户面板 |
| **设置中心分组** | `Settings Groups` | `SettingsView` 规范 5 组结构：外观与显示 / 更新与提醒 / 存储与下载 / 账号与网络 / 数据备份。 | 设置页、选项卡 |
| **OAuth Device Flow** | `OAuth Device Flow` | GitHub 登录设备码流程，Client ID 取自统一配置中枢 `config.toml`（支持设置项覆盖）；轮询容错 10 次、单次 10s 超时；`Expired` / `Denied` 独立状态机展示。 | 网页登录、PAT 登录 |
| **流式更新检查** | `Streaming Update Check` | 更新中心采用并发管道流式检测，实时发射 `zstore://update-check-progress` 推流事件，驱动逐项跳出微动效。 | 批量更新、后台检测 |
| **统一配置中枢** | `Unified Project Config` | `src-tauri/config.toml` 作为项目超参与默认配置的单一配置源 (SSOT)，结合编译期宏内置兜底与运行期动态重载。 | 配置文件、硬编码常量 |
| **规范应用标识** | `Canonical App Id` | 全系统唯一应用标识，统一为小写 `owner/repo`（GitHub）或 `forge[:host]:owner/repo`（多源）；id 即仓库坐标本身。入站标识（命令/深链/导入）一律经 `canonical_app_id()` 归一化，目录检索仅按 id 唯一匹配。详见 ADR-0010。 | 随机 UUID、应用别名 ID |
| **统一图标获取** | `IconFetch` | 后端统一图标补探核心（`github/icon_fetch.rs:fetch_icons_stream`），搜索与趋势后台均已接入流式补齐；仅负责探测与调度，不触 DB。 | 图标管道、补图核心 |
| **图标就绪事件** | `icon-ready` | 后端逐张发射的统一事件 `zstore://icon-ready{id,icon,level,via,context}`（`id` 即小写 `owner/repo`，与 DB 主键同源）；前端统一由 `iconStore.applyHit` 收口。 | 图标推送、icon 事件 |
| **搜索列表缓存** | `Search List Cache` | 搜索页纯前端内存搜缓存（搜缓存=搜索 L1，`services/search/searchListCache.ts`），key=`search\|归一query\|page\|perPage`，TTL 30min、空不存、上限 50 条 FIFO；不碰榜缓存二级落盘与趋势榜缓存。 | 搜索缓存、结果缓存 |
| **榜就绪门信号** | `boardReady` | 趋势视图内部态：`useTrendBoard` 内 hydrate 就绪门信号（`useTrendBoard.ts:79` 定义，L1/L2/网络三路径统一 emit 后置位，见 `setBoardReady`），仅供富卡升级判定、不阻塞裸行直展；对应 ADR-0014 榜 L2 落盘语义。 | 就绪态、加载完成 |
| **SWR 同步快照** | `swrSyncedResult` | 趋势视图内部态：当前榜单 SWR 合并完成快照判定（定义 `services/trends/board.ts:1056`，消费 `TrendsView.tsx:323`），快照与 hydrate 一致即原地升级富卡、不拦裸行。 | 同步结果、合并态 |
| **升级待定判定** | `isUpgradePending` | 趋势视图内部态：富卡升级待定判定（定义 `services/trends/board.ts:1073`，真实消费点 `TrendsView.tsx:324`），enrich 富卡升级路径经 `isUpgradePending(boardReady, swrSynced) && !isEnrichUpgradeAllowed(boardReady)` 门控，未就绪即延迟到 boardReady 置位后重入；仅门控升级、不阻塞裸行直展；内部视图态，非用户-facing。 | 待升级、pending 态 |
| **绘制同步回归线** | `paint-sync` | 测试专用 lane 名，非用户-facing 概念：驱逐写透/裸行直展回归（内存与盘所见即所得，见 `paint-sync.test.ts:2`、`TrendsView.paintSync.test.tsx:2`），仅测试命名。 | 首屏测试、渲染同步 |
| **待收录草稿** | `Draft` | 暂存于本地 `custom_apps` 表、尚未提交至独立生态清单仓库的收录候选条目（`status=draft`），经暂存校验（canonical 身份对齐）后参与合并目录视图，提交时才强制全字段校验。 | 草稿箱、未提交应用 |
| **自维护** | `Maintained` | 用户在本地自维护的收录条目（`custom_apps` 未归档行），经 overlay 合并进入目录视图并以 `source=custom` 标识，远端命中后自动转正归档。 | 本地条目、自定义应用 |
| **转正** | `Graduated` | 自维护草稿被远端精选收录库正式收录（`sync_catalog` 命中 canonical id），本地行置 `archived=1` 自动归档，不再参与合并视图。 | 毕业、上岸、合并完成 |
| **已收录/未收录** | `Cataloged/Uncataloged` | 卡片收录态徽标：id 命中精选收录库为已收录，否则为未收录（走详情缓存读富卡）；与自维护/转正正交（后者仅描述本地草稿生命周期）。 | 收录状态、有无收录 |
| **收录标记** | `is_cataloged` | 收藏/关注记录自带的收录态字段（0/1 持久化于 `user_favorites` / `watched_apps`）：写入时按内存目录判定一次，存量行启动回填；前端凭此决定走收录库还是详情缓存读卡。 | cataloged 字段、收录位 |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 纯粹开源 (Strictly FLOSS)**:
   - 仅收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等主流开源托管平台且拥有 OSI 认证开源协议的软件，严禁集成任何闭源专有软件包或商业广告推广；开源协议门禁经 `src-tauri/config.toml [license_gate]` 可配（默认开 + OSI 全量名单，D1 严格不变），关闭仅放行本地草稿提交（WARN 可审计），官方生态仓仍以 OSI 为准（见 ADR-0018）。
2. **D2 零服务器成本与解耦清单同步 (Serverless Direct API & Decoupled Manifest Sync)**:
   - 客户端从独立开源清单仓库（`superMC5657/z-store-catalog`）增量同步精选应用元数据（包含分类、英文原名、图标、多端标识符与仓库坐标等）；本地预置 `catalog.json` 种子清单兜底（详见 ADR-0009）。
   - 应用深度详情与构建资产通过 `ForgeProvider` 抽象层按需直连各代码源官方 REST API 获取，不设中心化聚合后端；
   - 本地 SQLite (`z_store.db`) 维护基于单一配置源（`src-tauri/config.toml`）的 TTL 缓存（基线 60 分钟，改库/导入值按挡位 `[0, 10, 60, 360, 1440]` 归一化，非法值回退 60），配合 HTTP ETag 304 条件请求实现零配额消耗延长缓存时效；该 TTL 仅约束详情浏览：非资产面（搜索/趋势/平台推导/图标/首页）默认自动拉取并经 ETag 条件请求复用，资产面（已安装应用、更新中心、收藏）仅手动触发网络——更新中心列表为手动快照（仅显式刷新写入 `update_results`，其余读库呈现），收藏/关注记录自带收录标记就近读卡；离线或请求失败时平滑回退本地持久化数据（详见 ADR-0007）。
   - 网络层自动继承操作系统代理与环境变量（Windows 下启动时自探测注册表且 https 优先，支持 Clash / v2ray / TUN 模式透明截获），与针对 Release 大文件下载的加速镜像节点正交可叠加；镜像切换永不写进程全局 `NO_PROXY`/`no_proxy`（仅 per-client `no_proxy` 生效）；`gh-proxy.com` 与趋势 host（`trend.doforce.dpdns.org`）为直连豁免，不走镜像（镜像代理仅下载）。
   - 所有已安装记录、用户设置、主机令牌（PAT）、更新规则、关注应用与本地足迹均保存在客户端本地嵌入式 SQLite 中（18 张核心表，见 `src-tauri/src/db/schema.rs:8-182`：`installed_apps` / `api_etag_cache` / `app_details_cache` / `user_settings` / `user_favorites` / `update_rules` / `search_history` / `view_history` / `host_tokens` / `watched_apps` / `user_stars` / `icon_cache_meta` / `app_icon_cycles` / `trend_board_cache` / `asset_cache` / `asset_refs` / `custom_apps` / `update_results`；其中 `icon_cache_meta` 追踪收录应用图标缓存来源，`app_icon_cycles` 追踪图标轮换状态，两表分流；`trend_board_cache` 为趋势榜 L2 缓存，后端命令 `get/save_trend_board_cache` 见 `src-tauri/src/commands/trends_cache.rs`，前端沿用同 key 直接命中；L2按榜双档 daily 1h/其余12h（见 `src/services/trends/cache.ts:19-21`），有效TTL=基线-min(抖动0-30s,基线/4)（见 `src/services/trends/cache.ts:42-59`），清扫双档对齐；后端写盘硬上限 512KiB（见 `src-tauri/src/db/cache.rs:215,249`），前端写前 256KB 预检、超限逐级裁剪（见 `src/services/trends/cache.ts:33,322`））。
   - 后端 `src-tauri/src/lib.rs:569-659` 共注册 89 个 commands（含 `zlog_get_dir` / `zlog_export_bundle`）；前端 IPC 唯一出口为CMD表+tauriApi（`src/services/api.ts:64-140` CMD 表 + `src/services/api.ts:165-256` `tauriApi` 经 `src/services/api/client.ts:1-10` `tauriInvoke`/`isTauri` 派发），视图层禁止直调 `invoke`（见 `src/views/noDirectInvoke.test.ts`）；前端无 router，用 `useState` 视图机（`ViewType` 8 种：`home|trends|categories|favorites|installed|updates|settings|pending`，见 `src/types/index.ts:140`；`App.tsx:59`）。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
    - 所有下载的二进制安装包强制流式计算 SHA-256 哈希值并与官方校验清单比对，哈希不符立即强行阻断并销毁临时文件（详见 ADR-0004）。
4. **D4 Linear 去彩单色界面 (Monochrome Design System)**:
   - 界面采用 Linear 风格的去彩单色体系：黑白灰画布、hairline 微边框、6/8px 圆角、510/590 字重与系统级深浅色自适应（Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。
   - 采用统一的线性矢量图标体系（统一由 `lucide-react` 14px/stroke 1.5 及单色矢量 SVG 驱动并适配 `currentColor`），状态反馈采用标准 CSS 微动效（如旋转 `.icon-spin`）与高亮状态指示原点（`.status-dot`），消除视觉割裂；基底保持单色，星级收藏（金 `#eab308`）、榜单排名（金/银/铜）与告警/错误等状态色为例外点缀，图标本体仍为单色 `currentColor`。
   - 侧栏底部常驻账号入口胶囊（`Account Capsule`），未登录显示登录入口，已登录呈现头像与用户名，点击直达设置中心账号卡片（`#settings-account`）。
5. **D5 双池复用 (Dual-Pool Client Reuse)**:
   - API 与图标下载使用物理隔离的复用单例 Client，均配置 connect_timeout 5s、keepalive 60s、pool 20/idle 90s；图标 CDN 通道恒丢 token，绝不携带认证头。
6. **D6 有限并发 (Bounded Concurrency)**:
   - 明星榜 `buffered(4)`、更新检查 `buffer_unordered(6)`（主路径与关注通知两处，见 `updates_check.rs:331,455`），首命中即停并按原顺序回填结果；SimpleIcons 快路径逐 slug 验图 `buffered(3)`（见 `github/icon_probe.rs:524`）。
    - 统一图标补探 `IconFetch` 有界池 `pool=5`（见 `config.rs:97-102 IconFetchConfig`）：搜索与趋势后台均经该核心逐张 `emit` 流式补齐；趋势 enrich 侧 `buffered(5)` 等齐（详见 ADR-0015）。
7. **D7 有限重试 (Limited Retry)**:
   - 仅 GET 可重试，仅覆盖传输错误与 429/5xx，最多重试 2 次并按 200ms→800ms 退避；401/404/304 永不重试。
8. **D8 首包验图与跳过 (First-Bytes Verify & Skip)**:
   - 图标先 HEAD 判类型长度，再 Range 取前 32KB 验 magic，失败回退全量 GET，并以 300B 最小阈值卡掉 LFS 指针文件；下载前 SHA-256 命中即零网络跳过，ETag 收敛至统一 helper，force 模式跳过 DB 读取。
9. **D9 趋势与首页 (Trending & Home)**:
   - 趋势复用共享 Client（见 `src-tauri/src/lib.rs:86-100`），经 tokio 10s 超时并截断 2MB 防爆内存；榜缓存一级内存分档（榜 L1，daily 1h/weekly-monthly-new 12h/其余 5min）+ 榜缓存二级落盘双档（榜 L2，daily 1h/其余 12h，见 `src/services/trends/cache.ts:19-21`；有效 TTL 扣抖动，见 `src/services/trends/cache.ts:42-59`）；内存 200 有界（见 `src/services/trends/cache.ts:31`）、切榜 sweep 无 timer；写盘 FE 256KB 预检、超限逐级裁剪（见 `src/services/trends/cache.ts:33,322`）、BE 512KiB 硬拒绝（见 `src-tauri/src/db/cache.rs:215,249`）；enrich 单次批量 40 上限（整批失败即整批缺席，不抛错，缺席留占位，避免第二片顶掉第一片慢尾）；429 透传 `retry_after_ms` 单次重试（上限 60s 缺省 5s，见 `src/services/trends/cache.ts:23-25`；详见 ADR-0014）；趋势 enrich 后台流式补探（首屏快返 + `fetch_icons_stream(Trend)` 逐张 emit，见 `src-tauri/src/commands/catalog_search.rs:649`），enrich 合并侧 `buffered(5)` 等齐（见 `src-tauri/src/commands/catalog_search.rs:561`）。首页固定 balanced 排序与 seed 7（见 `src/views/HomeView/useHomeFeed.ts:69-70`），不提供策略切换工具条。
10. **D10 统一图标获取 (Unified Icon Fetch)**:
    - 后端统一核心为 `src-tauri/src/github/icon_fetch.rs:229 fetch_icons_stream`，搜索与趋势后台均接入该核心逐张补齐。
    - 前端图标写入口唯一收口于 `src/services/iconStore.ts:703 applyHit`。
    - 搜缓存为 `src/services/search/searchListCache.ts` 纯前端内存缓存（key=`search|归一query|page|perPage`，见 `buildSearchListCacheKey:55`；TTL 30min 见 `SEARCH_LIST_TTL_MS:8`、上限 50 条 FIFO 见 `SEARCH_LIST_MAX_ENTRIES:10`），不碰榜缓存二级落盘与趋势榜缓存。
    - 图标就绪事件：只发 `zstore://icon-ready`（见 `src-tauri/src/github/icon_fetch.rs:126 emit_icon_ready`），前后端同一事件，载荷 `{id,icon,level,via,context}`（`id` 即小写 `owner/repo`，与 DB 主键同源）。
    - 详情仍走最强探测（动态分支 + 图标 L4=README，需网络；L3仅默认分支，详情失败用HEAD，README默认+HEAD），不受统一核心约束。
    - level纯L(1=L1官方,2=L2品牌库,3=L3仓库,4=L4 README)；缓存只用M(M1=前端内存，M2=DB落盘)，
      经 `via`=live|m2 正交表达（core探测一律live，DB回填走m2不占level）；level:4=L4。
    - 榜就绪门 `boardReady` 见 `src/views/TrendsView/useTrendBoard.ts:79`，SWR 快照 `swrSyncedResult` / 判定 `isUpgradePending` 定义见 `src/services/trends/board.ts:1056,1073`、消费见 `src/views/TrendsView.tsx:323-324`（仅门控富卡升级，不阻塞裸行直展）。
