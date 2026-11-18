# CONTEXT.md: ZStore 领域模型与核心契约

本项目为 **ZStore**，一个基于 **Tauri 2 + Rust + React 19** 构建的轻量级跨平台开源应用商店（界面以 Linear 去彩单色为主，Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。

---

## 一、统一领域词汇表 (Domain Glossary)

所有代码、Issue、ADR 与文档必须严格使用以下标准术语，严禁随意使用未经定义的同义词：

| 标准术语 (Term) | 英文标识 | 领域定义与业务边界 | 避免使用的非规范称呼 |
|---|---|---|---|
| **精选收录库** | `Curated Catalog` | 包含应用英文原名、图标、官方仓库坐标等元数据的精选开源应用清单。 | 应用市场、软件仓库 |
| **独立生态清单仓库** | `Decoupled Catalog Repository` | 独立维护于 `superMC5657/z-store-catalog` 的开源清单数据仓库，独立运作保鲜 CI 与准入校验，详见 ADR-0009。 | 中心数据库、后台仓库 |
| **种子清单兜底** | `Catalog Seed Fallback` | 客户端本地打包内置的 `catalog.json` 静态种子，仅在数据库首次初始化且 `catalog_apps` 为空时一次性播种写入，亦作离线显式降级源。 | 默认缓存、离线数据包 |
| **多端应用标识符** | `Platform Identifiers` | 按操作系统（Windows、Linux、macOS、Android、iOS）区分的原生进程/包名标识符映射字典，用于精准匹配管理与启动。 | 执行文件名、进程表 |
| **双维目录筛选** | `Bi-dimensional Filter` | 分类浏览中心提供的“设备平台（全部/Windows/Android/macOS/Linux/iOS）”与“功能分类（开发、影音等 10 类）”双维交叉过滤机制。其中设备平台轴取值为全部 + Windows/Android/macOS/Linux/iOS 五端，全部为不过滤快捷方式；空选择（`[]`）表示什么都不选，视图渲染空筛选状态；缺少本地键时回退全选，仅显式 `[]` 渲染空状态。设备平台轴为全站筛选：精选、趋势、开源广场、最新入库、分类、待收录、我的应用、收藏 / 关注一律按同一选择裁剪，搜索结果另以搜索集裁剪；各视图的角标与可见卡片同源，被筛空时渲染带重置入口的空筛选状态。侧栏平台芯片计数按当前视图（及子页 / 子签）所展示的数据集统计平台分布，离开视图即恢复全库分布。 | 标签过滤、分类切换 |
| **应用概要** | `AppSummary` | 列表页展示的轻量级实体，包含 Star 数、协议、分类、图标、多端平台支持与最新版本信息。 | 应用简报、AppInfo |
| **应用详情** | `AppDetail` | 弹窗呈现的完整元数据，包含对应 Release 的构建资产列表 (`releases`)、官方 README Markdown、分类与多端标识符等字段（以 `src-tauri/src/models.rs` 为准）。 | 详细信息、FullApp |
| **构建资产** | `ReleaseAsset` | Release 附带的编译产物二进制包（如 `.msi`、`.exe`、`.zip`、`.tar.gz`/`.tgz`/`.tar.xz`/`.tar`、`.deb`、`.dmg`、`.apk`，其中 `.7z`/`.tar.bz2`为Download-Only），带有平台架构分类。 | 附件、下载包、安装文件 |
| **托管源提供者** | `ForgeProvider` | 统一源代码托管抽象层，原生支持 GitHub、Codeberg、Gitea、GitLab 等开源代码源。详见 ADR-0006。 | 仓库源、平台接口 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理文件下载的反代节点（如 `gh-proxy.com`），支持在设置页手动切换前缀、`test_proxy` 手动测速与透明重写安装包下载 URL；镜像节点自身经 per-client `no_proxy` 直连，不消耗系统代理流量。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 ZStore 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **我的应用** | `My Apps` (`installed`) | 侧栏「管理」组下的一级视图，列出全部已安装应用，并就地呈现可用更新（版本差、更新日志、更新 / 全部更新）；深链 `zstore://view/updates` 打开此视图并落在「有更新」筛选签。列表与筛选签角标（全部 / 有更新 / 已冻结）同时受全局设备平台筛选与页内搜索框作用；未收录行按安装方式推导平台。详见 ADR-0022。 | 已安装页、更新中心、更新页 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite `api_etag_cache` 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测；覆盖清单、详情、`releases/latest`、画像同步、趋势 enrich、在线搜索与 Star 列表，按 `last_checked_at` LRU 限行（`API_ETAG_CACHE_MAX_ROWS`）。 | 本地缓存、HTTP缓存 |
| **清单同步** | `Manifest Catalog Sync` | 客户端从独立开源收录仓库动态拉取或增量刷新应用元数据清单的机制，跟随系统代理；官方默认源首跳传输失败 / 429 / 5xx 时经加速镜像节点重试一次并严格校验（非空且 id 全部合法），详见 ADR-0007、ADR-0009 与 ADR-0025。 | 清单下载、列表更新 |
| **缓存生存时效** | `Cache TTL` | 客户端本地持久化详情的有效周期（基线 60 分钟；设置页不暴露；后端对改库/导入值按挡位 `[0, 10, 60, 360, 1440]` 归一化，非法值回退 60），过期后触发带 ETag 的条件重新验证；仅约束详情浏览：非资产面（搜索/趋势/平台推导/图标/首页）默认自动拉取并经 ETag 条件请求复用，资产面（我的应用、收藏）仅手动触发网络——我的应用中的可用更新为手动快照（仅显式刷新写 `update_results`，其余读库），收藏/关注凭记录自带收录标记就近读卡。 | 缓存过期时间、过期策略 |
| **应用内仅下载** | `Download-Only` | 宿主不可安装的资产经应用内通道下载落盘、不调用安装器的模式，复用安装通道的镜像改写、SHA-256 校验与下载进度事件，落盘后可一键定位文件。 | 浏览器下载、直链下载 |
| **便携版应用** | `Portable App` | 免安装 ZIP/二进制tarball，剥顶层解压至AppData、Linux/macOS chmod兜底，仅本平台可装，自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式 (雪白超椭圆实底 + 晴空天蓝双环) 与暗黑模式 (暗夜实底 `#08090A` + 紫蓝极光双环) 的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |
| **协议深层链接** | `Deep Linking` | 注册系统级 `zstore://` URL Scheme，支持浏览器与外部链接一键呼起客户端直达详情、安装、搜索、开发者主页或指定视图路由。 | 外部协议、跳转链接 |
| **版本控制规则** | `Update Rule` | 持久化于本地 SQLite 的应用更新策略，支持跳过指定破坏性版本、永久锁定版本与隐藏特定仓库。锁定包含跳过：锁定后不检测更新、不保留跳过版本；隐藏只把应用移出列表与更新计数，其更新仍可在规则管理中跳过；不含任何策略的规则自动删除。 | 忽略更新、锁定版本 |
| **SHA-256 完整性校验** | `Checksum Verification` | 下载后强制 SHA-256 流式校验，与 `checksums.txt` / `SHA256SUMS` 比对（详见 ADR-0004）。 | Authenticode、证书校验、安全验签 |
| **存量应用管理** | `External App Management` | 多源扫描操作系统已安装软件（Windows 注册表 / Scoop / 开始菜单快捷方式、Linux `.desktop` / AppImage、macOS `.app`），经内存四路倒排索引与词元、路径段边界打分匹配精选收录库，用户核对本机原名与匹配依据后一键添加至管理列表并接管更新（ADR-0028）。 | 软件扫描、外部导入、应用纳管 |
| **Fluent 2 矢量图标体系** | `Fluent Vector Icon System` | 全站功能操作、导航菜单、设备平台标识及状态指示全面采用轻量线性矢量图标（`lucide-react` 与统一单色 SVG），配合 `currentColor` 主题自适应、CSS 微动效与状态指示原点（整体界面仍遵循 D4 Linear 去彩单色规范）。 | 功能Emoji、彩色贴图、图标库 |
| **主机配额指示器** | `Host Quota Indicator` | 各托管平台 API 调用配额的监听机制：后端解析限流头并经 `zstore://quota-updated` 广播；界面暂未消费该事件，账号卡片只展示需要登录的配额说明文案。 | 配额胶囊、限流状态 |
| **下载加速代理** | `Mirror Download Proxy` | 仅用于大文件下载提速的加速镜像节点重写（如 `gh-proxy.com`）；仅改变 GitHub 资产下载 URL 前缀并豁免该镜像 host，`direct` 档与非 GitHub 资产完整继承系统代理；API 与登录直接走系统网络通道。官方默认收录清单是唯一非安装包例外（见 ADR-0025）。 | 出站代理、镜像节点 |
| **GitHub登录胶囊** | `Account Capsule` | 侧栏底部常驻账号入口：未登录显示 GitHub 快捷登录入口，已登录显示用户头像与用户名；点击直达设置中心账号卡片（`#settings-account`）。 | 侧边栏按钮、用户面板 |
| **设置中心分组** | `Settings Groups` | `SettingsView` 规范 6 组结构：外观 / 更新与规则 / 存储与安装 / 网络（GitHub 账号卡片位于该组，锚点 `#settings-account`）/ 用户画像（本地隐私数据看板位于该组，锚点 `#settings-affinity`）/ 数据与备份（导出与备份统一操作行）。 | 设置页、选项卡 |
| **OAuth Device Flow** | `OAuth Device Flow` | GitHub 登录设备码流程，Client ID 取自统一配置中枢 `config.toml`（支持设置项覆盖）；轮询连续失败 10 次熔断，请求超时随 `network.api_timeout_seconds`（默认 12s），轮询间隔下限 1s；`Expired` / `Denied` 独立状态机展示。 | 网页登录、PAT 登录 |
| **流式更新检查** | `Streaming Update Check` | 「我的应用」的检查更新采用并发管道流式检测，实时发射 `zstore://update-check-progress` 推流事件，驱动顶栏下方的检查进度条；检查期间沿用上一份更新快照，结果回来后整体替换。 | 批量更新、后台检测 |
| **统一配置中枢** | `Unified Project Config` | `src-tauri/config.toml` 作为项目超参与默认配置的单一配置源 (SSOT)，结合编译期宏内置兜底与运行期动态重载。 | 配置文件、硬编码常量 |
| **规范应用标识** | `Canonical App Id` | 全系统唯一应用标识，统一为小写 `owner/repo`（GitHub）或 `forge:owner/repo`（非 GitHub 默认主机）/ `forge:host/owner/repo`（自建主机，host 后接 `/`）；id 即仓库坐标本身。入站标识（命令/深链/导入）一律经 `canonical_app_id()` 归一化，目录检索仅按 id 唯一匹配。详见 ADR-0010。 | 随机 UUID、应用别名 ID |
| **统一图标获取** | `IconFetch` | 后端统一图标补探核心（`src-tauri/src/icons/fetch.rs:fetch_icons_stream`），搜索与趋势后台均已接入流式补齐；仅负责探测与调度，不触 DB；逐张经统一事件 `zstore://icon-ready` 发射（`id` 即小写 `owner/repo`，与 DB 主键同源），前端统一由 `iconStore.admitIconHit` 收口。 | 图标管道、补图核心 |
| **搜索列表缓存** | `Search List Cache` | 在线搜索与 Star 列表的分页有序 id 索引（`services/search/searchListCache.ts`）：L1 前端内存，key=`命名空间\|归一query\|page\|perPage`，命名空间 `search` / `starred` 各自 50 条 FIFO，条目只存 `{ at, ids, hasMore, hasPrivate }`、卡片按 id 单份共享；5min 内新鲜可零网络直出，5–30min 需后台重验，30min 起驱逐，空不存。在线搜索另有 L2 SQLite `search_list_cache`（`v: 2` 有序 id，7 天保留，`has_private=1` 登出即清），冷启动经批量水合首绘。见 ADR-0027。 | 搜索缓存、结果缓存 |
| **单仓富卡派生缓存** | `Repo Enrich Cache` | 趋势、在线搜索与 Star 列表按规范应用标识共享的未收录应用轻量富卡：SQLite `repo_card_cache`（与 `catalog_apps` / `custom_apps` 物理隔离，2000 行按 `last_accessed_at` LRU，`is_private=1` 随登出清除）+ 前端 M1 镜像 `services/repoEnrichCache.ts`（底层 `trendEnrichCache` / `trendConfirmedOtherCache`，12h、600 条 FIFO）。三态均入池（具体平台 > 已确认 Other > 平台未知），空值与占位不覆盖实值，不存收录标注与 `data:` 图标；列表恢复经 `get_repo_cards_batch` / `hydrateCardsByIds` 批量水合。见 ADR-0027。 | 平台缓存、富卡缓存 |
| **Star 列表快照缓存** | `Starred Feed Cache` | 星标页「Star 同步」的 SQLite 瘦索引快照（`starred_feed_cache`，`v: 2` 按页有序 id，前 3 页 / 60 个 id，12h 新鲜、7 天保留、最多 15 个目标），进入视图经批量水合零网络直展；`@me:` 私有快照登出即清。见 ADR-0027。 | Star 缓存、收藏快照 |
| **待收录草稿** | `Draft` | 暂存于本地 `custom_apps` 表、尚未提交至独立生态清单仓库的收录候选条目（`status=draft`），经暂存校验（canonical 身份对齐）后参与合并目录视图，提交时才强制全字段校验。待收录页以四个平级 Tab 分组：草稿（`draft`）/ 待提交（收录态）/ 已提交（`submitted`）/ 已归档（`archived`），各 Tab 计数与列表均按全局设备平台筛选；侧栏「待收录」角标为未归档三组之和。 | 草稿箱、未提交应用 |
| **自维护** | `Maintained` | 用户在本地自维护的收录条目（`custom_apps` 未归档行），经 overlay 合并进入目录视图并以 `source=local` 标识，远端命中后自动转正归档。 | 本地条目、自定义应用 |
| **转正** | `Graduated` | 自维护草稿被远端精选收录库正式收录（`sync_catalog` 命中 canonical id），本地行置 `archived=1` 自动归档，退出合并视图。 | 毕业、上岸、合并完成 |
| **已收录/未收录** | `Cataloged/Uncataloged` | 卡片收录态徽标：id 命中精选收录库为已收录，否则为未收录（走详情缓存读富卡）；与自维护/转正正交（后者仅描述本地草稿生命周期）。 | 收录状态、有无收录 |
| **收录标记** | `is_cataloged` | 收藏/关注记录自带的收录态字段（0/1 持久化于 `user_favorites` / `watched_apps`）：写入时按目录判定一次，存量行启动回填、清单同步与本地收录状态切换后即时回填；前端凭此决定走收录库还是 `app_details` 读卡。 | cataloged 字段、收录位 |
| **本地收录来源** | `source=local` | 合并目录视图中本地库行的来源标记：仅库内成员（收录态或已提交 Issue（`submitted`））且未归档的 `custom_apps` 行进入合并（远端优先去重，补位行与远端同仓叠加行均标 `local`）；库存恒 `is_cataloged=true`、`is_verified=false`（永不冒充已验证蓝标，Issue 预填载荷翻 `true` 仅限复制体）。后端统一目录模块 `CatalogService` 在 `AppSummary` / `AppDetail` 投影时直接盖章 `source`（`CATALOG_SOURCE_REMOTE` `remote` / `CATALOG_SOURCE_LOCAL` `local`）与 `is_cataloged`（未收录即显式 `false`），前端优先读卡片字段；仅乐观本地行与缺省字段载荷由 `selectors` 兼容层（`annotateIsCataloged` / `annotateLocalSource`）补齐，不作为真值。 | 本地来源、收录来源 |
| **本地收录态** | `collected` / `local_collected` | 本地收录状态：`collected` 为现行写入值，`local_collected` 为存储层同义值（判定与列表均等同 `collected`）；收录态判定唯一口径为 `isCollectedStatus`（实现居 `src/services/custom.ts`，`src/app/selectors.ts` 单一重导出）。这是「可提交 Issue / 可退回草稿」的门禁口径，不等于库内成员（见本地库）。 | 已收录态、本地态 |
| **本地库** | `Local Library` | 用户本地可搜可装的自维护条目集合：`custom_apps` 中未归档且 `status` 为收录态（collected/local_collected）或已提交 Issue（submitted）的行。库内判定唯一口径为 `isLocalLibraryStatus`；`draft` 不在库，`archived` 退出库（权威交还远端）。 | 我的应用、本地列表 |
| **已提交** | `Submitted` | 库内条目已提交 Issue、等待上游收录的阶段（`status=submitted` + `pr_url`）。仍是库内成员：可搜可装、带黄标；不可重复提交 Issue、不可退回草稿；可「标记为未提交」回到待提交（Issue 需自行关闭）。 | 待合入、PR 中 |
| **本地收录徽标** | `verified-badge-local` | 本地收录行的橘黄徽标变体（浅色 `#F59E0B`、深色 `#D97706`，见 `components-app-card.css`）：已验证蓝标优先，本地收录仅在未验证时叠加；为 D4 去彩例外点缀（与星级金、榜单金/银/铜、告警/错误色同类）。 | 黄标、本地标 |
| **确认图标** | `Confirmed Icon` | `app_icon_cycles` 表 + 本地 `icons/` 磁盘图标文件（`sha256(url)[0:16].{ext}`）已落定的可直显图标：若 `cache_file` 为空但磁盘已有对应哈希文件则自愈关联并作为 M2 `data:` 直显（涵盖 L1–L4），无磁盘文件时 L1–L3 为远端回退、L4 为空；7 天 TTL 外遇网络波动自动回退本地旧图标文件（SWR）；榜重挂时经 `getConfirmedIconsBatch` 本地回填（DB-only：零网络、只进内存呈现，收录应用无 cycle 行时回退检查 `icons/` 磁盘缓存）。与统一图标获取（后端探测与流式事件）及 M1/M2 缓存分层正交。 | 落定图标、本地回填 |
| **收录时间** | `added_at` | 精选收录库与自维护本地库中应用被正式收录的入库日期（ISO `YYYY-MM-DD` 格式字符串），`custom_apps` 本地库条目以其创建时间 `created_at` 投影回填；用于时效性倒排与时间分期筛选。 | 入库时间、收录日期 |
| **最新入库** | `New Arrivals` (`latest`) | 侧栏「发现」组下的独立一级导航视图，按收录时间 `added_at` 倒序呈现精选收录与本地库应用；支持预设分段选项卡（最近 7 天、最近 30 天、最近 90 天）快速过滤，并以 `stars` 降序作为同批并列的二级保质排序。列表分页由后端按当前平台筛选允许的 ID 先过滤再分页，标题角标取该时间窗在当前筛选下的总匹配数。详见 ADR-0021。 | 最新收录、新增应用、新货上架 |
| **本地亲和度画像** | `User Affinity Profile` | 纯客户端内存聚合的开源偏好画像（`src-tauri/src/github/affinity.rs::UserAffinityProfile`），消费本地 SQLite 中的仓库特征信号（`user_repo_signals`）、应用内星标/收藏/关注（`user_stars`、`user_favorites`、`watched_apps`）、已安装（`installed_apps`）、浏览与搜索历史（`view_history`、`search_history`）、兴趣种子与推荐负反馈；收藏/关注/已安装/星标按 30 天半衰期、浏览与搜索按 7 天半衰期衰减。应用内信号与 GitHub 信号分两个通道各自软饱和归一化后按 0.65 : 0.35 融合，兴趣种子作为分类先验合入；词袋使用中英双语分词与目录级 IDF，关键词分按命中词降序固定系数加权（多命中只加分）；未收录应用的本地信号回退读取 `app_details` 概要。输出分类权重、开发者权重、关键词词袋权重与推荐种子，驱动精选页推荐货架（`get_featured_page`）与 Feed 排序（`get_home_feed`）的个性化重排（见 ADR-0024）。 | 云端画像、用户推荐模型 |
| **推荐货架** | `Featured Shelf` | 精选页由后端一次组装的推荐区块（`get_featured_page`，见 ADR-0023、ADR-0024）：今日为你（hero）、因为你 X 了 Y（`because_you`）、分类为你挑选（`category_pick`）、探索新领域（`explore`）、本月新入库（`fresh`）；整页同一应用只出现一次。已安装、已收藏、已关注的应用不进货架（仍可作为 `because_you` 的种子）；`rich` 画像的 `because_you` 不足 2 排时补出本月新入库；货架按日期种子宽幅抖动轮换。 | 推荐位、推荐栏 |
| **推荐理由** | `Recommendation Reason` | 推荐条目附带的可解释来源（`Reason`：种子、分类、作者、关键词、新入库、探索），由 `affinity_explain` 与打分共用同一分项计算得出，每条至多 2 个。 | 推荐原因、推荐标签 |
| **推荐种子** | `Seed` | 画像中命中精选收录库、用户与之有显式关系（收藏、安装、关注、Star、Fork、自有）的应用，按近期强度排序，是「因为你 X 了 Y」货架的出发点。 | 源应用、锚点应用 |
| **兴趣种子** | `Interest Seed` | 冷启动时用户在精选页兴趣选择卡中显式选择的分类（`user_interest_seeds`），不衰减，只进分类权重。 | 兴趣标签、初始偏好 |
| **推荐负反馈** | `Feed Dismissal` | 用户对推荐的否定（`user_feed_feedback`）：`app` 范围使该应用 90 天内不进推荐货架并在排序中沉底；`category` 范围使该分类画像权重减半并在打分中抑制 90 天，该分类不进任何推荐货架、hero 只在其余分类不足时用它补位，从卡片发起时连带屏蔽该卡片；可在本地隐私数据看板清空。 | 屏蔽、不喜欢 |
| **画像状态** | `Profile State` | 精选页的个性化分档：`off`（本地应用信息与 GitHub 用户信息两个信号源开关都关闭，编辑精选）、`cold`（开启但无信号，显示兴趣选择卡）、`warm`（1–4 个信号）、`rich`（≥5 个信号）。 | 推荐模式、冷热启动 |
| **日期种子** | `Day Seed` | 前端按本地日期给出的 `yyyymmdd` 整数，作为推荐货架的确定性抖动种子：当天稳定、隔天轮换。 | 随机种子、每日种子 |
| **仓库特征信号** | `Repo Affinity Signal` | 持久化于本地 `user_repo_signals` 表的用户 GitHub Star（`starred`）、Fork（`forked`）与自有仓库（`owned`）元数据（含 `stars`、`forks`、`language`、`description`；时间取真实标星时间 `starred_at` 或仓库最近推送 `pushed_at`），在首次登录及跨周期启动（6 小时冷却 + 按页 `api_etag_cache` 条件请求与 `304` LRU 保鲜，单端点上限 50 页）时静默同步。 | 仓库历史、远端画像 |
| **本地隐私数据看板** | `Affinity Privacy Audit Panel` | 设置页「用户画像」分组中的可视化隐私审计与控制组件（`AffinityPrivacyRow`），只读展示本地 SQLite 信号计数（含已安装、浏览、搜索与已屏蔽推荐）、Top 偏好分类、编程语言与兴趣种子，并提供本地应用信息（`enable_local_affinity`：收藏、关注、已安装、浏览、搜索）与 GitHub 用户信息（`enable_github_affinity`：Star、Fork、自有仓库，关闭时启动、登录与手动同步都不发请求）两个推荐信号源开关（兴趣方向不受开关影响），以及立即增量同步与清空推荐反馈能力；锚点 `#settings-affinity`。 | 推荐设置面板、隐私开关 |
| **开源广场** | `Launchpad` (`launchpad`) | 侧栏「发现」组下的独立视图（趋势之后、待收录之前），展示独立开发者新锐开源作品的置顶推荐与最新上架流，提供一键 Star、GitHub Discussions 评论与 `+1` 顶帖、一键安装。数据来自独立数据仓 `superMC5657/z-store-launchpad` 的 `launchpad.json` 并叠加 GitHub Discussions 实时脉冲，只落 `launchpad_feed_cache` 与 `launchpad_discussion_cache`，与精选收录库物理隔离；深链 `zstore://launchpad` 直达视图，`zstore://launchpad/{app_id}` 定位新品并打开详情（不自动安装）。详见 ADR-0029。 | 新品市场、推广页、广告位 |
| **置顶推荐** | `Spotlight` | 开源广场顶部的置顶赞助坑位（上限 4 个），可展示精选开源新品或经维护者人工审核的开发者向商业赞助/广告；`pin_until` 到期由数据仓每日工作流与客户端解析双端撤回最新上架流，同页同一应用只出现一次；卡片恒带单色 `.status-tag`（`置顶推荐` / `Spotlight` 或赞助标识），绝不进入精选目录与推荐打分。 | 竞价排名、推荐权重位 |
| **作者自荐语** | `Maker Note` | 作者投稿时填写的一句话介绍（`maker_note`，单行 1..=140 字符；可选英文 `maker_note_en`，英文界面优先展示），在广场卡片上以两行截断的引用块呈现。 | 广告语、Slogan |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 精选库纯粹开源 (Strictly FLOSS Catalog)**:
   - 精选收录库（`z-store-catalog`）、分类、趋势、搜索与本地推荐严格仅收录和分发托管于 GitHub、Codeberg、Gitea、GitLab 等主流开源托管平台且拥有 OSI 认证开源协议的软件，严禁将闭源专有软件或商业推广混入目录索引与推荐打分；开源协议门禁经 `src-tauri/config.toml [license_gate]` 可配（默认开 + OSI 全量名单，D1 严格不变），关闭仅放行本地草稿提交（WARN 可审计），官方生态仓仍以 OSI 为准（见 ADR-0018）。
   - 开源广场（Launchpad）的普通上架流面向满足 OSI 协议与可安装 Release 门槛的开源新品；顶部置顶推荐（`Spotlight`）支持开源项目赞助与经维护者人工审核的开发者向商业赞助/广告，恒带单色 `.status-tag` 标识，物理隔离于 `catalog_apps` 与推荐算法之外，且客户端保持零行为埋点与零追踪（见 ADR-0029）。
2. **D2 零服务器成本与解耦清单同步 (Serverless Direct API & Decoupled Manifest Sync)**:
   - 客户端从独立开源清单仓库（`superMC5657/z-store-catalog`）增量同步精选应用元数据（包含分类、英文原名、图标、多端标识符与仓库坐标等）；本地预置 `catalog.json` 种子清单兜底（详见 ADR-0009）。
   - 开源广场清单（`[launchpad].default_source_url` → `superMC5657/z-store-launchpad`）仅在进入广场视图或广场深链时按需拉取：无令牌、`If-None-Match` 条件请求，首跳传输错误 / 429 / 5xx 且启用非 `direct` 镜像时经镜像重试一次并严格校验；清单快照与讨论脉冲落在 `launchpad_feed_cache` / `launchpad_discussion_cache`（顶帖、评论、讨论读取及进入视图后的 `sync_launchpad_discussions` 实时脉冲同步均即时写库并跨重启水合，登出清除本人顶帖态），失败回退快照并标记 `is_stale`，永不写 `catalog_apps` / `custom_apps`。讨论区与卡片脉冲已登录走 GraphQL（现行 `public_repo user` 授权，无需重新授权），未登录走匿名 REST + `api_etag_cache` 只读降级（见 ADR-0029）。
   - 应用深度详情与构建资产通过 `ForgeProvider` 抽象层按需直连各代码源官方 REST API 获取，不设中心化聚合后端；
   - 后端统一目录模块 `CatalogService`（`src-tauri/src/github/catalog_service.rs`）结合仓储层（`src-tauri/src/repositories/`）持有远端精选目录（`catalog_apps` 表持久化，首次启动由 `catalog.json` 播种，启动后台按北京时间 14:00 / 06:00 UTC 切日每日增量同步并支持手动强制覆盖，详情刷新同步回写最新统计与版本，平台、协议、主页与图标仅在收录项缺省或占位时补齐（收录库精校值优先，不被详情覆盖））+ 本地收录 overlay（`custom_apps` 表）；收录检索、坐标解析、搜索、首页/分类、详情投影统一经该模块，并在 `AppSummary` / `AppDetail` 上盖章 `source`（`remote`/`local`）与 `is_cataloged`；
   - 本地 SQLite (`z_store.db`) 维护 TTL 缓存（基线 60 分钟）配合 HTTP ETag 304 条件请求；分面策略与挡位归一化详见 ADR-0007。在线搜索与 Star 列表同样走 ETag 条件请求，网络或限流失败时回退旧载荷；趋势榜、Star 列表与在线搜索的 SQLite 列表快照（`trend_board_cache` / `starred_feed_cache` / `search_list_cache`）只存 `v: 2` 有序 id 索引，未收录应用的卡片、平台与已确认 Other 由 `repo_card_cache` 跨重启承接（表结构以 `db/schema.rs::init_schema` 为准）；账号私有（`@me:`）快照、`has_private=1` 搜索快照、`is_private=1` 单仓富卡与 `/user/` ETag 随登出清除（见 ADR-0026、ADR-0027）。
   - 网络层运行期动态继承操作系统代理（`proxy::ProxySnapshot`：启动 env → Windows 注册表 / GNOME / macOS 实时读取，5 秒采样、传输失败即重探，开关代理无需重启）；Release 大文件下载走下载加速代理（正交可叠加，详见 ADR-0002 与 ADR-0025）。官方默认收录清单首跳失败可经镜像回退，校验清单 `checksums.txt` 恒直连或走系统代理、绝不经镜像。
   - 所有已安装记录、用户设置、主机速率快照与只读令牌记录（`host_tokens`）、更新规则、关注应用、仓库特征信号（`user_repo_signals`）与本地足迹均保存在客户端本地嵌入式 SQLite 中；表清单以 `src-tauri/src/db/schema.rs::init_schema` 为准，榜缓存与图标分流语义见 ADR-0014/ADR-0015，文档不记具体数字（令牌威胁模型与风险接受见 ADR-0020）。
   - 后端 commands 注册表以 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 为准（含 zlog 命令）；前端唯一出口为 CMD 表 + `tauriInvoke` 派发，视图层禁直调 `invoke`，请求键命名规则以 AGENTS.md 为准；前端用 `useState` 视图机（`ViewType` 见 `src/types/index.ts`）。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
    - 所有下载的二进制安装包强制流式计算 SHA-256 哈希值并与官方校验清单比对，哈希不符立即强行阻断并销毁临时文件（详见 ADR-0004）。
4. **D4 Linear 去彩单色界面 (Monochrome Design System)**:
   - 界面采用 Linear 风格的去彩单色体系：黑白灰画布、hairline 微边框、6/8px 圆角、510/590 字重与系统级深浅色自适应（Fluent 仅指 `lucide-react` 矢量图标体系，不要求 Acrylic/品牌蓝）。
   - 采用统一的线性矢量图标体系（统一由 `lucide-react` 14px/stroke 1.5 及单色矢量 SVG 驱动并适配 `currentColor`），状态反馈采用标准 CSS 微动效（如旋转 `.icon-spin`）与高亮状态指示原点（`.status-dot`），消除视觉割裂；基底保持单色，星级收藏（金 `#eab308`）、榜单排名（金/银/铜）、本地收录徽标（橘黄 `verified-badge-local`：浅色 `#F59E0B`/深色 `#D97706`，仅未验证时叠加）与告警/错误等状态色为例外点缀，图标本体仍为单色 `currentColor`。
   - 侧栏底部账号入口胶囊与设置中心分组见词汇表；网络/认证与分组规范见 ADR-0008。
   - 文字型状态标记（已归档、置顶推荐 / Spotlight、讨论区「作者 / Maker」等）统一用 `.status-tag`，不使用彩色实心标签。
5. **D5 双池复用 (Dual-Pool Client Reuse)**:
   - API 与图标下载使用物理隔离的复用 Client（`forge::http` 的 `SHARED_API` / `SHARED_ICON` 槽位，`shared_http_client` 与 API 池同池），均配置 connect_timeout 5s、keepalive 60s、pool 20/idle 90s；图标 CDN 通道恒丢 token，绝不携带认证头。清单同步另设独立第三 Client（`CatalogService::http_client`：拉取公开静态内容、token 恒不携带，connect 5s / pool 10，超时走 `api_timeout_seconds`），与图标池同构的 token 卫生边界（见 ADR-0012）；安装包下载器（`installer::downloader_http`）按「代理签名 + 镜像豁免 host」键维护有界复用池（`DOWNLOAD_CLIENTS`，上限 8），避免连续下载重建连接池。上述四类池与趋势 doforce 直连池（`commands::network::trend_direct_client`，整体超时 5s、无 Token）均以系统代理签名为键（`proxy::ClientSlot`）：签名不变复用连接池，代理开关或切换后自动重建（见 ADR-0025）。
6. **D6 有限并发 (Bounded Concurrency)**:
   - 明星榜 `buffered(4)`、更新检查 `buffer_unordered(6)`（`commands/updates_check.rs` 的 `check_for_updates` 与 `check_watched_updates` 两处），首命中即停并按原顺序回填结果；SimpleIcons 快路径逐 slug 验图 `buffered(3)`（见 `icons/probe.rs`）。
    - 统一图标补探 `IconFetch` 有界池 `pool=5` 无序并发（`buffer_unordered(pool)`，见 `icons/fetch.rs`；配置见 `config.rs` 的 `IconFetchConfig`）：搜索与趋势后台均经该核心逐张 `emit` 流式补齐；趋势 enrich 批量直查侧 `buffered(5)` 保序等齐（见 `commands/catalog_search.rs`，详见 ADR-0015）。
7. **D7 有限重试 (Limited Retry)**:
   - 仅 GET 可重试，仅覆盖传输错误与 429/5xx，最多重试 2 次；5xx 与传输错误按 200ms→800ms 退避，429 优先按服务端 `Retry-After`（秒值夹 60s 上限，缺失/非数字用 5s 缺省，与 D9 同口径）；401/404/304 永不重试。
8. **D8 首包验图与跳过 (First-Bytes Verify & Skip)**:
   - 图标先 HEAD 判类型长度（404/410 确定性不存在状态码立即短路，不进入后续请求），再 Range 取前 32KB 验 magic，失败回退全量 GET，并以 300B 最小阈值卡掉 LFS 指针文件；下载前 SHA-256 命中即零网络跳过，ETag 收敛至统一 helper，force 模式跳过 DB 读取。
9. **D9 趋势与首页 (Trending & Home)**:
   - 趋势复用共享 Client（`shared_http_client`，见 `src-tauri/src/lib.rs`），`github.com` / `api.github.com` 经 tokio 10s 超时、doforce 直连 5s 失败且有系统代理时经代理重试 6s（见 ADR-0025），并截断 2MB 防爆内存；榜缓存一级内存分档（榜 L1，daily 1h/weekly-monthly-new 12h/其余 5min）+ 榜缓存二级落盘双档（榜 L2，daily 1h/其余 12h，见 `src/services/trends/cache.ts::trendDbTtlMs`；有效 TTL 扣抖动，见同文件 `trendL2EffectiveTtlMs`）；内存 200 有界（`TRENDS_CACHE_MAX_ENTRIES`）、切榜 sweep 无 timer；榜单 L2 只存 `{ v: 2, items: [{ id, stars, starsGained?, forks? }] }` 排行索引，仅在抓榜成功时写一次，FE 32 KiB 预检（`TREND_DB_PAYLOAD_MAX_BYTES`）、BE 64 KiB 硬拒绝 + 至多 30 行（见 `src-tauri/src/db/cache.rs`）；冷启动由 `TrendBoardSession` 经 `hydrateCardsByIds` 从 `repo_card_cache` 批量水合卡片，水合落定后只对缺失或超 12h 的仓库 enrich（见 ADR-0027）；enrich 单次批量 40 上限（整批失败即整批缺席，不抛错，缺席留占位，避免第二片顶掉第一片慢尾）；429 透传 `retry_after_ms` 单次重试（上限 60s 缺省 5s，见 `src/services/trends/cache.ts` 的 `DOFORCE_RETRY_MAX_WAIT_MS` / `DOFORCE_RETRY_DEFAULT_WAIT_MS`；详见 ADR-0014）；趋势 enrich 后台流式补探（首屏批量直查不内联探图、只取仓库元数据快返，图标仅由 `fetch_icons_stream(Trend)` 为未收录且无确认图标的仓探一次并逐张 emit，见 `src-tauri/src/commands/catalog_search.rs`）；`new` 榜经 `fetch_trends_text` 请求 `api.github.com` 时附带活跃 GitHub Token，`github.com` 与 doforce 不带凭据，`useTrendEnrichment` 按 `(trendResult, activeBoard)` 周期去重已尝试坐标，单仓 enrich 缺席不重入递增 `BOARD_GEN`；enrich 批量直查侧 `buffered(5)` 保序等齐（同上）。精选页展示后端一次组装的推荐货架（`get_featured_page`，画像状态分档与推荐理由见 ADR-0023）及下方的「继续查看」最近浏览富卡区块，全库浏览由分类与搜索承接；后端 `get_home_feed` 提供固定 `balanced` 排序与日期种子的分页目录接口（见 ADR-0013）。
10. **D10 统一图标获取 (Unified Icon Fetch)**:
    - 后端统一核心为 `src-tauri/src/icons/fetch.rs` 的 `fetch_icons_stream`，搜索、趋势、星标页 Star 列表与开源广场后台均接入该核心逐张补齐；四者各用独立世代计数器（`SEARCH_GEN` / `BOARD_GEN` / `STARRED_GEN` / `LAUNCHPAD_ICON_GEN`，后者对应 `IconFetchCtx::Launchpad`，每次拉取广场清单推进一代），互不作废对方的在途补图。
    - 前端图标写入口唯一收口于 `src/services/iconStore.ts` 的 `admitIconHit`；`get_or_fetch_icon` 落盘读回 `data:` 后经 `subscribeIconDataReady` 通知挂载的 `AppIcon` 即时切换为本地 `data:`。真实 Tauri 运行时下未命中 `data:` 的远端图标不挂远端 `<img>`，由后端单飞获取；后端失败进入退避并唤醒组件后才回退 WebView 直连，再失败定格首字母徽章（非 Tauri 单测与官网 Demo 直出远端 `<img>`，报错后经后端自愈）。README / 更新日志插图（`useResolvedMarkdownImages`）与 GitHub 头像（`CachedAvatar`）经 `fetch_or_cache_asset_url` 返回 `data:` 渲染，同一图片不前后端双发（见 ADR-0025）；`enrichTrendReposCore` 与 `putTrendEnrichMemory` 收到确认 `data:` 图标时同步经 `admitIconHit({ via: 'm2' })` 写入 M1 内存缓冲，并将 `icon` 剥空为 `''` 后把完整富卡写入 `trendEnrichCache`（绝不因 `data:` 丢弃富卡）；后端 `repo_card_cache` 同样只存远端 `http(s)` 图标，确认图标在 `get_repo_cards_batch` 读出时叠加。
    - 搜缓存为 `src/services/search/searchListCache.ts` 纯前端内存缓存（key=`命名空间|归一query|page|perPage`，命名空间缺省 `search`，星标页 Star 列表用 `starred`，各自独立 FIFO；读写入口 `readSearchListCacheEntry` / `writeSearchListCache`，详情更新经 `patchSearchListCacheRows` 全字段写透；新鲜窗口、TTL 与容量以 `searchListCache.ts` 常量为准），与榜缓存二级落盘及趋势榜缓存相互独立。
    - 单仓富卡派生缓存（`src/services/repoEnrichCache.ts` + `repo_card_cache`）让趋势、在线搜索与 Star 列表互享卡片、已推导的平台与已确认 Other，并跨重启保留：列表组装时首帧回填，平台懒回填结果写回，已确认 Other 的行跳过 `get_platforms_lite`（后端 `get_platforms_lite` 亦对 12h 内已落定的卡片零网络直返）；后端 `backfill_uncataloged_card` 先合并 `repo_card_cache`，再从 `app_details` 与 `api_etag_cache` 的 `releases/latest` 载荷零网络回填平台与版本（见 ADR-0026、ADR-0027）。
    - 图标就绪事件：只发 `zstore://icon-ready`（见 `src-tauri/src/icons/fetch.rs` 的 `emit_icon_ready`），前后端同一事件，载荷 `{id,icon,level,via,context}`（`id` 即小写 `owner/repo`，与 DB 主键同源）。
    - 详情走全层级探测（`pick_detail_icon_with_level` 显式保留 L1 官方 / L2 SimpleIcons / L3 Git Trees / L4 README 真实来源级别，L2/L3 与 L4 同时命中时顺手通过 `fill_probe_slot` 补齐 `l4_url` 备选槽；L3 分支解析 `resolve_probe_branches` 与详情均在 `default_branch` 失败时回退 `"HEAD"`），不受统一流式核心熔断约束。
    - level纯L(1=L1官方,2=L2品牌库,3=L3仓库,4=L4 README,5=L5用户显式切空)；缓存只用M(M1=前端内存，M2=DB落盘)，
      经 `via`=live|m2 正交表达（core探测一律live，DB回填走m2不占level）。
    - 榜就绪门控（`boardReady` / SWR 快照判定）仅门控富卡升级、不阻塞裸行直展，实现见 `src/services/trends/board.ts` 与 `useTrendBoard.ts`。
