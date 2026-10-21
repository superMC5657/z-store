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
| **应用详情** | `AppDetail` | 弹窗呈现的完整元数据，包含对应 Release 的构建资产列表 (`releases`)、官方 README Markdown、分类与多端标识符等字段（以 `src-tauri/src/models.rs` 为准）。 | 详细信息、FullApp |
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
| **主机配额指示器** | `Host Quota Indicator` | 各托管平台 API 调用配额的监听机制：后端解析限流头并经 `zstore://quota-updated` 广播；界面暂未消费该事件，账号卡片只展示需要登录的配额说明文案。 | 配额胶囊、限流状态 |
| **下载加速代理** | `Mirror Download Proxy` | 仅用于大文件下载提速的加速镜像节点重写（如 `gh-proxy.com`）；仅改变下载 URL 前缀，API 与登录直接走系统网络通道。 | 出站代理、镜像节点 |
| **GitHub登录胶囊** | `Account Capsule` | 侧栏底部常驻账号入口：未登录显示 GitHub 快捷登录入口，已登录显示用户头像与用户名；点击直达设置中心账号卡片（`#settings-account`）。 | 侧边栏按钮、用户面板 |
| **设置中心分组** | `Settings Groups` | `SettingsView` 规范 5 组结构：外观与个性化 / 更新与规则 / 存储与安装 / 网络与数据（GitHub 账号卡片位于该组，锚点 `#settings-account`）/ 数据管理与备份。 | 设置页、选项卡 |
| **OAuth Device Flow** | `OAuth Device Flow` | GitHub 登录设备码流程，Client ID 取自统一配置中枢 `config.toml`（支持设置项覆盖）；轮询连续失败 10 次熔断，请求超时随 `network.api_timeout_seconds`（默认 12s），轮询间隔下限 1s；`Expired` / `Denied` 独立状态机展示。 | 网页登录、PAT 登录 |
| **流式更新检查** | `Streaming Update Check` | 更新中心采用并发管道流式检测，实时发射 `zstore://update-check-progress` 推流事件，驱动逐项跳出微动效。 | 批量更新、后台检测 |
| **统一配置中枢** | `Unified Project Config` | `src-tauri/config.toml` 作为项目超参与默认配置的单一配置源 (SSOT)，结合编译期宏内置兜底与运行期动态重载。 | 配置文件、硬编码常量 |
| **规范应用标识** | `Canonical App Id` | 全系统唯一应用标识，统一为小写 `owner/repo`（GitHub）或 `forge:owner/repo`（非 GitHub 默认主机）/ `forge:host/owner/repo`（自建主机，host 后接 `/`）；id 即仓库坐标本身。入站标识（命令/深链/导入）一律经 `canonical_app_id()` 归一化，目录检索仅按 id 唯一匹配。详见 ADR-0010。 | 随机 UUID、应用别名 ID |
| **统一图标获取** | `IconFetch` | 后端统一图标补探核心（`src-tauri/src/github/icon_fetch.rs:fetch_icons_stream`），搜索与趋势后台均已接入流式补齐；仅负责探测与调度，不触 DB；逐张经统一事件 `zstore://icon-ready` 发射（`id` 即小写 `owner/repo`，与 DB 主键同源），前端统一由 `iconStore.admitIconHit` 收口。 | 图标管道、补图核心 |
| **搜索列表缓存** | `Search List Cache` | 搜索页纯前端内存搜缓存（搜缓存=搜索 L1，`services/search/searchListCache.ts`），key=`search\|归一query\|page\|perPage`，TTL 30min、空不存、上限 50 条 FIFO；不碰榜缓存二级落盘与趋势榜缓存。 | 搜索缓存、结果缓存 |
| **待收录草稿** | `Draft` | 暂存于本地 `custom_apps` 表、尚未提交至独立生态清单仓库的收录候选条目（`status=draft`），经暂存校验（canonical 身份对齐）后参与合并目录视图，提交时才强制全字段校验。 | 草稿箱、未提交应用 |
| **自维护** | `Maintained` | 用户在本地自维护的收录条目（`custom_apps` 未归档行），经 overlay 合并进入目录视图并以 `source=custom` 标识，远端命中后自动转正归档。 | 本地条目、自定义应用 |
| **转正** | `Graduated` | 自维护草稿被远端精选收录库正式收录（`sync_catalog` 命中 canonical id），本地行置 `archived=1` 自动归档，不再参与合并视图。 | 毕业、上岸、合并完成 |
| **已收录/未收录** | `Cataloged/Uncataloged` | 卡片收录态徽标：id 命中精选收录库为已收录，否则为未收录（走详情缓存读富卡）；与自维护/转正正交（后者仅描述本地草稿生命周期）。 | 收录状态、有无收录 |
| **收录标记** | `is_cataloged` | 收藏/关注记录自带的收录态字段（0/1 持久化于 `user_favorites` / `watched_apps`）：写入时按目录判定一次，存量行启动回填、清单同步与本地收录状态切换后即时回填；前端凭此决定走收录库还是详情缓存读卡。 | cataloged 字段、收录位 |
| **本地收录来源** | `source=local` | 合并目录视图中本地库行的来源标记：仅库内成员（收录态或已提交 Issue（`submitted`））且未归档的 `custom_apps` 行进入合并（远端优先去重，补位行与远端同仓叠加行均标 `local`）；库存恒 `is_cataloged=true`、`is_verified=false`（永不冒充已验证蓝标，Issue 预填载荷翻 `true` 仅限复制体）。后端统一目录模块在 `AppSummary` / `AppDetail` 投影时直接盖章 `source` 与 `is_cataloged`（`remote`/`local`，未收录即显式 `false`），前端优先读卡片字段；仅乐观本地行与旧载荷由 `selectors` 兼容层（`annotateIsCataloged` / `annotateLocalSource`）补齐，不作为真值。同一 overlay 行存在双层表达：合并视图条目枚举（`MergedCatalogEntry.source`）为 `CatalogEntrySource::Custom`（序列化 `custom`，对应 `remote`），卡片盖章字段（`AppSummary.source`）为 `local`（对应 `remote`）——投影时 `Custom` 恒映射为 `local`，前者适用目录条目枚举/检索侧，后者适用卡片投影字段。 | 本地来源、收录来源 |
| **本地收录态** | `collected` / `local_collected` | 本地收录状态：`collected` 为现行写入值，`local_collected` 为磁盘残留同义值（判定与列表均等同 `collected`）；收录态判定唯一口径为 `isCollectedStatus`（实现居 `src/services/custom/status.ts`，`src/app/selectors.ts` 单一重导出）。这是「可提交 Issue / 可退回草稿」的门禁口径，不等于库内成员（见本地库）。 | 已收录态、本地态 |
| **本地库** | `Local Library` | 用户本地可搜可装的自维护条目集合：`custom_apps` 中未归档且 `status` 为收录态（collected/local_collected）或已提交 Issue（submitted）的行。库内判定唯一口径为 `isLocalLibraryStatus`；`draft` 不在库，`archived` 退出库（权威交还远端）。 | 我的应用、本地列表 |
| **已提交** | `Submitted` | 库内条目已提交 Issue、等待上游收录的阶段（`status=submitted` + `pr_url`）。仍是库内成员：可搜可装、带黄标；不可重复提交 Issue、不可退回草稿；可「标记为未提交」回到待提交（Issue 需自行关闭）。 | 待合入、PR 中 |
| **本地收录徽标** | `verified-badge-local` | 本地收录行的橘黄徽标变体（浅色 `#F59E0B`、深色 `#D97706`，见 `components-app-card.css`）：已验证蓝标优先，本地收录仅在未验证时叠加；为 D4 去彩例外点缀（与星级金、榜单金/银/铜、告警/错误色同类）。 | 黄标、本地标 |
| **确认图标** | `Confirmed Icon` | `app_icon_cycles` 表 + 本地图标文件已落定的可直显图标：M2 为 `data:` 直显，L1-L3 为远端回退，L4 无（即空）；榜重挂时经 `getConfirmedIconsBatch` 本地回填（DB-only：零网络、零写盘、只进内存呈现）。与统一图标获取（后端探测与流式事件）及 M1/M2 缓存分层正交。 | 落定图标、本地回填 |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 纯粹开源 (Strictly FLOSS)**:
   - 仅收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等主流开源托管平台且拥有 OSI 认证开源协议的软件，严禁集成任何闭源专有软件包或商业广告推广；开源协议门禁经 `src-tauri/config.toml [license_gate]` 可配（默认开 + OSI 全量名单，D1 严格不变），关闭仅放行本地草稿提交（WARN 可审计），官方生态仓仍以 OSI 为准（见 ADR-0018）。
2. **D2 零服务器成本与解耦清单同步 (Serverless Direct API & Decoupled Manifest Sync)**:
   - 客户端从独立开源清单仓库（`superMC5657/z-store-catalog`）增量同步精选应用元数据（包含分类、英文原名、图标、多端标识符与仓库坐标等）；本地预置 `catalog.json` 种子清单兜底（详见 ADR-0009）。
   - 应用深度详情与构建资产通过 `ForgeProvider` 抽象层按需直连各代码源官方 REST API 获取，不设中心化聚合后端；
   - 后端统一目录模块 `CatalogService`（`src-tauri/src/github/catalog_service.rs`）持有远端精选目录 + 本地收录 overlay（启动与 `custom_apps` 变更后同步）；收录检索、坐标解析、搜索、首页/分类、详情投影统一经该模块，并在 `AppSummary` / `AppDetail` 上盖章 `source`（`remote`/`local`）与 `is_cataloged`；
   - 本地 SQLite (`z_store.db`) 维护 TTL 缓存（基线 60 分钟）配合 HTTP ETag 304 条件请求；分面策略与挡位归一化详见 ADR-0007。
   - 网络层自动继承操作系统代理；Release 大文件下载走下载加速代理（正交可叠加，详见 ADR-0002）。
   - 所有已安装记录、用户设置、主机令牌（PAT）、更新规则、关注应用与本地足迹均保存在客户端本地嵌入式 SQLite 中；表清单以 `src-tauri/src/db/schema.rs::init_schema` 为准，榜缓存与图标分流语义见 ADR-0014/ADR-0015，文档不记具体数字（令牌威胁模型与风险接受见 ADR-0020）。
   - 后端 commands 注册表以 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 为准（含 zlog 命令）；前端唯一出口为 CMD 表 + `tauriInvoke` 派发，视图层禁直调 `invoke`，请求键命名规则以 AGENTS.md 为准；前端用 `useState` 视图机（`ViewType` 见 `src/types/index.ts`）。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
    - 所有下载的二进制安装包强制流式计算 SHA-256 哈希值并与官方校验清单比对，哈希不符立即强行阻断并销毁临时文件（详见 ADR-0004）。
4. **D4 Linear 去彩单色界面 (Monochrome Design System)**:
   - 界面采用 Linear 风格的去彩单色体系：黑白灰画布、hairline 微边框、6/8px 圆角、510/590 字重与系统级深浅色自适应（Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。
   - 采用统一的线性矢量图标体系（统一由 `lucide-react` 14px/stroke 1.5 及单色矢量 SVG 驱动并适配 `currentColor`），状态反馈采用标准 CSS 微动效（如旋转 `.icon-spin`）与高亮状态指示原点（`.status-dot`），消除视觉割裂；基底保持单色，星级收藏（金 `#eab308`）、榜单排名（金/银/铜）、本地收录徽标（橘黄 `verified-badge-local`：浅色 `#F59E0B`/深色 `#D97706`，仅未验证时叠加）与告警/错误等状态色为例外点缀，图标本体仍为单色 `currentColor`。
   - 侧栏底部账号入口胶囊与设置中心分组见词汇表；网络/认证与分组规范见 ADR-0008。
5. **D5 双池复用 (Dual-Pool Client Reuse)**:
   - API 与图标下载使用物理隔离的复用单例 Client，均配置 connect_timeout 5s、keepalive 60s、pool 20/idle 90s；图标 CDN 通道恒丢 token，绝不携带认证头。清单同步另设独立第三 Client（CatalogService 自建：拉取公开静态内容、token 恒不携带，connect 5s / pool 10，超时走 `api_timeout_seconds`），与图标池同构的 token 卫生边界（见 ADR-0012）。
6. **D6 有限并发 (Bounded Concurrency)**:
   - 明星榜 `buffered(4)`、更新检查 `buffer_unordered(6)`（`commands/updates_check.rs` 主路径与关注通知两处），首命中即停并按原顺序回填结果；SimpleIcons 快路径逐 slug 验图 `buffered(3)`（见 `github/icon_probe.rs`）。
    - 统一图标补探 `IconFetch` 有界池 `pool=5` 无序并发（`buffer_unordered(pool)`，见 `github/icon_fetch.rs`；配置见 `config.rs` 的 `IconFetchConfig`）：搜索与趋势后台均经该核心逐张 `emit` 流式补齐；趋势 enrich 批量直查侧 `buffered(5)` 保序等齐（见 `commands/catalog_search.rs`，详见 ADR-0015）。
7. **D7 有限重试 (Limited Retry)**:
   - 仅 GET 可重试，仅覆盖传输错误与 429/5xx，最多重试 2 次；5xx 与传输错误按 200ms→800ms 退避，429 优先按服务端 `Retry-After`（秒值夹 60s 上限，缺失/非数字用 5s 缺省，与 D9 同口径）；401/404/304 永不重试。
8. **D8 首包验图与跳过 (First-Bytes Verify & Skip)**:
   - 图标先 HEAD 判类型长度，再 Range 取前 32KB 验 magic，失败回退全量 GET，并以 300B 最小阈值卡掉 LFS 指针文件；下载前 SHA-256 命中即零网络跳过，ETag 收敛至统一 helper，force 模式跳过 DB 读取。
9. **D9 趋势与首页 (Trending & Home)**:
   - 趋势复用共享 Client（`shared_http_client`，见 `src-tauri/src/lib.rs`），经 tokio 10s 超时并截断 2MB 防爆内存；榜缓存一级内存分档（榜 L1，daily 1h/weekly-monthly-new 12h/其余 5min）+ 榜缓存二级落盘双档（榜 L2，daily 1h/其余 12h，见 `src/services/trends/cache.ts::trendDbTtlMs`；有效 TTL 扣抖动，见同文件 `trendL2EffectiveTtlMs`）；内存 200 有界（`TRENDS_CACHE_MAX_ENTRIES`）、切榜 sweep 无 timer；写盘 FE 256KB 预检、超限逐级裁剪（`TREND_DB_PAYLOAD_MAX_BYTES`）、BE 512KiB 硬拒绝（见 `src-tauri/src/db/cache.rs` 的 `TREND_BOARD_CACHE_MAX_BYTES`）；enrich 单次批量 40 上限（整批失败即整批缺席，不抛错，缺席留占位，避免第二片顶掉第一片慢尾）；429 透传 `retry_after_ms` 单次重试（上限 60s 缺省 5s，见 `src/services/trends/cache.ts` 的 `DOFORCE_RETRY_MAX_WAIT_MS` / `DOFORCE_RETRY_DEFAULT_WAIT_MS`；详见 ADR-0014）；趋势 enrich 后台流式补探（首屏快返 + `fetch_icons_stream(Trend)` 逐张 emit，见 `src-tauri/src/commands/catalog_search.rs`），enrich 批量直查侧 `buffered(5)` 保序等齐（同上）。首页固定 balanced 排序与 seed 7（见 `src/views/HomeView/useHomeFeed.ts`），不提供策略切换工具条。
10. **D10 统一图标获取 (Unified Icon Fetch)**:
    - 后端统一核心为 `src-tauri/src/github/icon_fetch.rs` 的 `fetch_icons_stream`，搜索与趋势后台均接入该核心逐张补齐。
    - 前端图标写入口唯一收口于 `src/services/iconStore.ts` 的 `admitIconHit`。
    - 搜缓存为 `src/services/search/searchListCache.ts` 纯前端内存缓存（key=`search|归一query|page|perPage`，读写入口 `readSearchListCache` / `writeSearchListCache`；TTL 30min、上限 50 条 FIFO 以 `searchListCache.ts` 常量为准），不碰榜缓存二级落盘与趋势榜缓存。
    - 图标就绪事件：只发 `zstore://icon-ready`（见 `src-tauri/src/github/icon_fetch.rs` 的 `emit_icon_ready`），前后端同一事件，载荷 `{id,icon,level,via,context}`（`id` 即小写 `owner/repo`，与 DB 主键同源）。
    - 详情仍走最强探测（动态分支 + 图标 L4=README，需网络；L3仅默认分支，详情失败用HEAD，README默认+HEAD），不受统一核心约束。
    - level纯L(1=L1官方,2=L2品牌库,3=L3仓库,4=L4 README)；缓存只用M(M1=前端内存，M2=DB落盘)，
      经 `via`=live|m2 正交表达（core探测一律live，DB回填走m2不占level）；level:4=L4。
    - 榜就绪门控（`boardReady` / SWR 快照判定）仅门控富卡升级、不阻塞裸行直展，实现见 `src/services/trends/board.ts` 与 `useTrendBoard.ts`。
