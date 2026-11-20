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
| **双维目录筛选** | `Bi-dimensional Filter` | 设备平台（全部 + Windows/Android/macOS/Linux/iOS）与功能分类（10 类）交叉过滤机制；其中设备平台轴作用于全站视图（空选择 `[]` 渲染空筛选状态，侧栏平台芯片计数统计当前视图数据集的平台分布）。 | 标签过滤、分类切换 |
| **应用概要** | `AppSummary` | 列表页展示的轻量级实体，包含 Star 数、协议、分类、图标、多端平台支持与最新版本信息。 | 应用简报、AppInfo |
| **应用详情** | `AppDetail` | 弹窗呈现的完整元数据，包含对应 Release 的构建资产列表 (`releases`)、官方 README Markdown、分类与多端标识符等字段（以 `src-tauri/src/models.rs` 为准）。 | 详细信息、FullApp |
| **构建资产** | `ReleaseAsset` | Release 附带的编译产物二进制包（安装包、便携包及 `.apk`/`.7z` 等仅下载格式），带有平台架构分类。 | 附件、下载包、安装文件 |
| **托管源提供者** | `ForgeProvider` | 统一源代码托管抽象层，原生支持 GitHub、Codeberg、Gitea、GitLab 等开源代码源。详见 ADR-0006。 | 仓库源、平台接口 |
| **校验清单** | `Checksum Manifest` | Release 附带的 `checksums.txt` / `SHA256SUMS`，记录官方预期 SHA-256 哈希值。 | 哈希表、签名文件 |
| **加速镜像节点** | `MirrorNode` | 代理文件下载的反代节点（如 `gh-proxy.com`），支持设置页切换、测速与透明重写安装包下载 URL；镜像节点自身直连，不消耗系统代理流量。 | 代理源、加速线路、CDN |
| **已安装应用** | `InstalledApp` | 由 ZStore 管理且持久化存储在本地 SQLite 中的应用实体，包含本地路径与卸载入口。 | 本地应用、已装软件 |
| **我的应用** | `My Apps` (`installed`) | 侧栏「管理」组下的一级视图，合并展示已安装应用与可用更新（含全部 / 有更新 / 已冻结筛选签，受全局平台筛选与页内搜索框作用）；深链 `zstore://view/updates` 定位至此视图的「有更新」筛选签。详见 ADR-0022。 | 已安装页、更新中心、更新页 |
| **条件请求缓存** | `ETag Cache` | 存储于本地 SQLite `api_etag_cache` 中的 HTTP 304 缓存机制，通过 `If-None-Match` 实现零配额消耗更新检测；覆盖清单、详情、`releases/latest`、画像同步、趋势 enrich、在线搜索与 Star 列表，按最近检查时间 LRU 限行。 | 本地缓存、HTTP缓存 |
| **清单同步** | `Manifest Catalog Sync` | 客户端从独立开源收录仓库增量拉取精选元数据的机制，跟随系统代理；官方默认源首跳失败时经加速镜像节点重试并严格校验，详见 ADR-0007、ADR-0009 与 ADR-0025。 | 清单下载、列表更新 |
| **缓存生存时效** | `Cache TTL` | 客户端本地持久化详情的有效周期（过期后触发带 ETag 的条件重新验证，挡位以后端归一化为准）。仅约束详情浏览：非资产面（搜索/趋势/平台推导/图标/首页）默认自动拉取，资产面（我的应用、收藏）仅手动触发网络。 | 缓存过期时间、过期策略 |
| **应用内仅下载** | `Download-Only` | 宿主不可安装的资产经应用内通道下载落盘、不调用安装器的模式，复用安装通道的镜像改写、SHA-256 校验与进度事件，落盘后可一键定位文件。 | 浏览器下载、直链下载 |
| **便携版应用** | `Portable App` | 免安装 ZIP/二进制 tarball，解压至 AppData（仅本平台可装），自动创建桌面快捷方式与提供卸载清理。 | 绿色软件、免安装版 |
| **双模标识系统** | `Adaptive Icon System` | 包含明亮模式与暗黑模式的三层图标分层架构，涵盖桌面打包与多端自适应，详见 ADR-0005。 | 软件LOGO、系统图标 |
| **协议深层链接** | `Deep Linking` | 系统级 `zstore://` URL Scheme，支持外部一键呼起客户端直达详情、安装、搜索、开发者主页、开源广场或指定视图。 | 外部协议、跳转链接 |
| **版本控制规则** | `Update Rule` | 持久化于本地 SQLite 的应用更新策略，支持跳过指定版本、永久锁定版本（不检测更新）与隐藏特定仓库（移出主列表但保留规则管理入口）；不含策略的规则自动删除。 | 忽略更新、锁定版本 |
| **SHA-256 完整性校验** | `Checksum Verification` | 下载后强制 SHA-256 流式校验，与官方 `Checksum Manifest` 比对（详见 ADR-0004）。 | Authenticode、证书校验、安全验签 |
| **存量应用管理** | `External App Management` | 多源扫描操作系统已安装软件，经倒排索引与边界打分匹配精选收录库，用户核对后一键纳入管理并接管更新（ADR-0028）。 | 软件扫描、外部导入、应用纳管 |
| **Fluent 2 矢量图标体系** | `Fluent Vector Icon System` | 全站采用 `lucide-react` 与单色矢量 SVG 配合 `currentColor` 自适应及标准 CSS 微动效，整体遵循 D4 Linear 去彩单色规范。 | 功能Emoji、彩色贴图、图标库 |
| **主机配额指示器** | `Host Quota Indicator` | 各托管平台 API 调用配额的监听机制：后端解析限流头并广播 `zstore://quota-updated`，账号卡片展示配额说明。 | 配额胶囊、限流状态 |
| **下载加速代理** | `Mirror Download Proxy` | 用于大文件下载提速的加速镜像重写：仅改写 GitHub 资产下载 URL 前缀并豁免该镜像 host，`direct` 档与非 GitHub 资产继承系统代理；API 与登录直接走系统代理（官方默认收录清单是唯一非安装包例外，见 ADR-0025）。 | 出站代理、镜像节点 |
| **GitHub登录胶囊** | `Account Capsule` | 侧栏底部常驻账号入口：未登录显示快捷登录入口，已登录显示头像与用户名，点击直达设置中心账号卡片（`#settings-account`）。 | 侧边栏按钮、用户面板 |
| **设置中心分组** | `Settings Groups` | `SettingsView` 规范 6 组结构：外观 / 更新与规则 / 存储与安装 / 网络（含 `#settings-account`）/ 用户画像（含 `#settings-affinity`）/ 数据与备份。 | 设置页、选项卡 |
| **OAuth Device Flow** | `OAuth Device Flow` | GitHub 登录设备码流程，Client ID 取自统一配置中枢 `config.toml`（支持设置覆盖）；含连续失败熔断与过期/拒绝独立状态。 | 网页登录、PAT 登录 |
| **流式更新检查** | `Streaming Update Check` | 「我的应用」并发流式检查更新，实时发射 `zstore://update-check-progress` 驱动进度条；检查期间保留上一份更新快照并在完成后整体替换。 | 批量更新、后台检测 |
| **统一配置中枢** | `Unified Project Config` | `src-tauri/config.toml` 作为超参与默认配置的单一配置源 (SSOT)，结合编译期内置兜底与运行期重载。 | 配置文件、硬编码常量 |
| **规范应用标识** | `Canonical App Id` | 全系统唯一应用标识，统一为小写 `owner/repo`（GitHub）、`forge:owner/repo` 或 `forge:host/owner/repo`；所有入站标识均须经 `canonical_app_id()` 归一化。详见 ADR-0010。 | 随机 UUID、应用别名 ID |
| **统一图标获取** | `IconFetch` | 后端流式图标补探核心（`src-tauri/src/icons/fetch.rs`），供搜索、趋势、Star 列表与开源广场共用；只做探测与调度、不触 DB，命中通过 `zstore://icon-ready` 发射并由前端 `iconStore` 统一收口。 | 图标管道、补图核心 |
| **搜索列表缓存** | `Search List Cache` | 在线搜索与 Star 列表的分页有序 id 索引（前端内存 + 在线搜索 SQLite `search_list_cache`），与卡片数据分离存储、按 id 共享水合；登出时清除私有快照。见 ADR-0027。 | 搜索缓存、结果缓存 |
| **单仓富卡派生缓存** | `Repo Enrich Cache` | 趋势、在线搜索与 Star 列表共享的未收录应用轻量富卡池（SQLite `repo_card_cache` + 前端内存镜像），与 `catalog_apps` / `custom_apps` 物理隔离；统一存储三态平台与非 `data:` 图标，供列表批量水合。见 ADR-0027。 | 平台缓存、富卡缓存 |
| **Star 列表快照缓存** | `Starred Feed Cache` | 星标页「Star 同步」的 SQLite 瘦索引快照（`starred_feed_cache`），按页有序保存 id 并配合 `repo_card_cache` 批量水合；`@me:` 私有快照随登出清除。见 ADR-0027。 | Star 缓存、收藏快照 |
| **待收录草稿** | `Draft` | 暂存于本地 `custom_apps` 表、尚未提交至独立生态清单仓库的收录候选条目（`status=draft`）；待收录页分草稿 / 待提交 / 已提交 / 已归档四个平级 Tab，侧栏角标为未归档三组之和。 | 草稿箱、未提交应用 |
| **自维护** | `Maintained` | 用户在本地自维护的收录条目（`custom_apps` 未归档行），经 overlay 合并进入目录视图并以 `source=local` 标识，远端命中后自动转正归档。 | 本地条目、自定义应用 |
| **转正** | `Graduated` | 自维护草稿被远端精选收录库正式收录（`sync_catalog` 命中 canonical id），本地行自动归档并退出合并视图。 | 毕业、上岸、合并完成 |
| **已收录/未收录** | `Cataloged/Uncataloged` | 卡片收录态徽标：id 命中精选收录库或本地库为已收录，否则为未收录（走详情或富卡缓存读卡）；与自维护/转正正交。 | 收录状态、有无收录 |
| **收录标记** | `is_cataloged` | 收藏/关注记录自带的收录态标记（持久化于 `user_favorites` / `watched_apps`），在写入、启动、清单同步及本地收录切换时回填，决定前端按收录库还是详情缓存读卡。 | cataloged 字段、收录位 |
| **本地收录来源** | `source=local` | 合并目录视图中本地库成员的来源标记（恒 `is_cataloged=true`、`is_verified=false`），由后端目录服务在 `AppSummary` / `AppDetail` 投影时统一盖章。 | 本地来源、收录来源 |
| **本地收录态** | `collected` / `local_collected` | 处于待提交阶段的本地收录状态（`collected` 为现行写入值，`local_collected` 为存储层同义值），是提交 Issue 与退回草稿的前置门禁状态。 | 已收录态、本地态 |
| **本地库** | `Local Library` | 用户本地可搜可装的自维护条目集合：`custom_apps` 中未归档且处于收录态（`collected`/`local_collected`）或已提交（`submitted`）的行。 | 我的应用、本地列表 |
| **已提交** | `Submitted` | 已提交 Issue 等待上游收录的本地库成员（`status=submitted` + `pr_url`）；仍可搜可装并带本地徽标，不可重复提交 Issue，可人工退回待提交。 | 待合入、PR 中 |
| **本地收录徽标** | `verified-badge-local` | 本地收录行的橘黄徽标变体：已验证蓝标优先，本地收录仅在未验证时叠加，属于 D4 去彩规范中的状态点缀例外。 | 黄标、本地标 |
| **确认图标** | `Confirmed Icon` | `app_icon_cycles` 表与本地 `icons/` 磁盘缓存已落定的可直显图标；列表挂起或重挂时经批量查询本地零网络回填（M2），失效时按 SWR 回退旧盘文件。 | 落定图标、本地回填 |
| **收录时间** | `added_at` | 精选收录库与本地库条目正式收录的入库日期（ISO `YYYY-MM-DD`），本地库条目以创建时间投影回填。 | 入库时间、收录日期 |
| **最新入库** | `New Arrivals` (`latest`) | 侧栏「发现」组下的独立一级视图，按 `added_at` 倒序（同批按 `stars` 降序）展示精选与本地库应用；支持时间窗切换，后端按当前平台筛选预过滤并分页。详见 ADR-0021。 | 最新收录、新增应用、新货上架 |
| **本地亲和度画像** | `User Affinity Profile` | 纯客户端聚合的开源偏好画像（`src-tauri/src/github/affinity.rs`），综合本地互动、安装/浏览/搜索历史、兴趣种子、推荐负反馈与 GitHub 仓库信号，输出分类/作者/词袋权重及推荐种子以驱动精选页货架与 Feed 重排（见 ADR-0024）。 | 云端画像、用户推荐模型 |
| **推荐货架** | `Featured Shelf` | 精选页由后端一次组装的推荐区块（今日为你 / 因为你 X 了 Y / 分类为你挑选 / 探索新领域 / 本月新入库），整页不重复且排除已安装/已收藏/已关注应用，按日期种子宽幅抖动轮换（见 ADR-0023、ADR-0024）。 | 推荐位、推荐栏 |
| **推荐理由** | `Recommendation Reason` | 推荐条目附带的可解释来源（种子、分类、作者、关键词、新入库、探索），与推荐打分同源计算得出。 | 推荐原因、推荐标签 |
| **推荐种子** | `Seed` | 画像中命中精选收录库且用户与之有显式关系的应用，作为「因为你 X 了 Y」货架的锚点。 | 源应用、锚点应用 |
| **兴趣种子** | `Interest Seed` | 冷启动时用户在精选页兴趣选择卡中显式选择的分类（`user_interest_seeds`），不随时间衰减。 | 兴趣标签、初始偏好 |
| **推荐负反馈** | `Feed Dismissal` | 用户对推荐的否定（`user_feed_feedback`）：按应用或分类抑制推荐曝光与排序权重，可在本地隐私数据看板清空。 | 屏蔽、不喜欢 |
| **画像状态** | `Profile State` | 精选页的个性化分档：`off`（双信号源关闭，编辑精选）、`cold`（无信号，显示兴趣选择卡）、`warm`（少量信号）、`rich`（充足信号）。 | 推荐模式、冷热启动 |
| **日期种子** | `Day Seed` | 前端按本地日期生成的 `yyyymmdd` 整数，用于推荐货架的确定性抖动（当天稳定、隔天轮换）。 | 随机种子、每日种子 |
| **仓库特征信号** | `Repo Affinity Signal` | 持久化于本地 `user_repo_signals` 表的用户 GitHub Star、Fork 与自有仓库元数据，在登录与跨周期启动时通过 ETag 条件请求静默同步。 | 仓库历史、远端画像 |
| **本地隐私数据看板** | `Affinity Privacy Audit Panel` | 设置页「用户画像」分组中的审计与控制组件（`AffinityPrivacyRow`，锚点 `#settings-affinity`），展示本地信号计数与偏好摘要，提供本地行为/GitHub 信号双开关、立即同步与清空反馈。 | 推荐设置面板、隐私开关 |
| **开源广场** | `Launchpad` (`launchpad`) | 侧栏「发现」组下的独立视图，展示独立开发者新锐开源作品的置顶推荐与最新上架流，支持 Star、GitHub Discussions 评论/顶帖与安装；数据来自 `superMC5657/z-store-launchpad`，与精选目录物理隔离。详见 ADR-0029。 | 新品市场、推广页、广告位 |
| **置顶推荐** | `Spotlight` | 开源广场顶部的置顶赞助坑位，可展示精选开源新品或经人工审核的开发者向商业赞助；到期自动撤出且卡片恒带单色 `.status-tag`，绝不进入精选目录与推荐打分。 | 竞价排名、推荐权重位 |
| **作者自荐语** | `Maker Note` | 作者投稿时填写的一句话介绍（`maker_note` / 可选 `maker_note_en`），在广场卡片上以引用块呈现。 | 广告语、Slogan |

---

## 二、架构核心边界与原则 (Architectural Invariants)

1. **D1 精选库纯粹开源 (Strictly FLOSS Catalog)**:
   - 精选收录库（`z-store-catalog`）、分类、趋势、搜索与本地推荐仅收录和分发托管于主流开源平台且拥有 OSI 认证开源协议的软件，严禁混入闭源软件或商业推广；开源协议门禁经 `src-tauri/config.toml [license_gate]` 可配（关闭仅放行本地草稿提交并记录审计日志，见 ADR-0018）。
   - 开源广场（Launchpad）的普通上架流仅面向符合 OSI 协议与可安装门槛的开源新品；顶部置顶推荐（`Spotlight`）支持经审核的开发者向商业赞助，恒带单色 `.status-tag` 标识，与 `catalog_apps` 和推荐算法物理隔离，客户端保持零行为埋点（见 ADR-0029）。
2. **D2 零服务器成本与解耦清单同步 (Serverless Direct API & Decoupled Manifest Sync)**:
   - 客户端从 `superMC5657/z-store-catalog` 增量同步精选应用元数据，本地内置 `catalog.json` 作种子与离线兜底（ADR-0009）。
   - 开源广场清单仅在进入广场视图或广场深链时按需拉取（无令牌 ETag 条件请求，官方源首跳失败可经镜像校验重试），清单快照与讨论脉冲落在隔离缓存表（`launchpad_feed_cache` / `launchpad_discussion_cache`），永不写入 `catalog_apps` / `custom_apps`；讨论区已登录走 GraphQL，未登录走匿名 REST 只读降级（ADR-0029）。
   - 应用详情与构建资产通过 `ForgeProvider` 直连各代码源官方 API 获取，不设中心化聚合后端。
   - 后端 `CatalogService`（`src-tauri/src/github/catalog_service.rs`）结合仓储层（`src-tauri/src/repositories/`）统一持有远端精选目录（`catalog_apps`）与本地收录 overlay（`custom_apps`），并负责检索、坐标解析、列表投影及在 `AppSummary` / `AppDetail` 上权威盖章 `source` 与 `is_cataloged`。
   - 本地 SQLite (`z_store.db`) 维护 TTL 与 HTTP ETag 304 条件请求缓存（ADR-0007）；趋势榜、Star 列表与在线搜索的 SQLite 列表快照仅存有序 id 索引，未收录应用的卡片与平台由 `repo_card_cache` 跨重启承接（表结构以 `db/schema.rs::init_schema` 为准）；账号私有快照与凭据相关 ETag 随登出清除（ADR-0026、ADR-0027）。
   - 网络层运行期动态读取操作系统代理（Windows 注册表 / GNOME / macOS），按代理签名复用并热重建连接池，传输失败时自动重探（ADR-0025）；下载加速镜像仅重写资产下载 URL（官方默认清单为唯一非安装包回退例外），校验清单 `checksums.txt` 绝不经镜像。
   - 本地状态（已安装记录、设置、主机速率、令牌 `host_tokens`、更新规则、关注、仓库信号与足迹）均保存在本地 SQLite，令牌威胁模型见 ADR-0020；文档不记具体实现数值与阈值，以配置和源码常量为准。
   - 后端命令注册表以 `src-tauri/src/lib.rs` 为准；前端统一通过 CMD 表与 `tauriInvoke` 派发，视图层禁止直调 `invoke`，请求键命名遵守 `AGENTS.md`。
3. **D3 零信任完整性防篡改 (Zero-Trust Anti-Tampering)**:
   - 下载的二进制安装包强制流式计算 SHA-256 哈希并与官方校验清单比对，不符立即阻断并销毁临时文件（ADR-0004）。
4. **D4 Linear 去彩单色界面 (Monochrome Design System)**:
   - 界面遵循 Linear 去彩单色体系：黑白灰画布、hairline 边框、系统级深浅色自适应；功能操作与状态统一采用 `lucide-react` 与单色 SVG（`currentColor`）配合标准 CSS 微动效（`.icon-spin`）与状态原点（`.status-dot`）。
   - 仅星级收藏、榜单排名、本地收录徽标（`verified-badge-local`，仅未验证时叠加）与告警/错误使用语义色点缀；文字型状态标记统一使用 `.status-tag`。
   - 侧栏账号胶囊与设置中心 6 组结构见词汇表与 ADR-0008。
5. **D5 多池隔离与按代理签名复用 (Isolated Pooled Clients)**:
   - API 请求、图标/CDN 下载、清单同步、安装包下载与趋势直连使用物理隔离的 `reqwest::Client` 池；图标/CDN 池、清单池与趋势直连池绝不携带认证 Token（ADR-0012）。
   - 各类长生命周期池均以系统代理签名为键复用与原子热重建，镜像下载通道按需将镜像 host 加入 per-client `no_proxy` 豁免（ADR-0025）。
6. **D6 有限并发 (Bounded Concurrency)**:
   - 明星榜、更新检查、SimpleIcons 验图、趋势 enrich 与 `IconFetch` 均受有界并发池约束，按原序或世代受控回填，避免突发请求打爆配额或连接数（ADR-0015）。
7. **D7 有限重试 (Limited Retry)**:
   - 仅幂等 GET 在传输错误与 429/5xx 时执行有界重试（429 优先遵守受限夹紧的 `Retry-After`）；401/404/304 永不重试。
8. **D8 首包验图与跳过 (First-Bytes Verify & Skip)**:
   - 图标探测先 HEAD 判类型与长度（404/410 立即短路），再 Range 拉取头部字节校验图像魔数与最小体积以过滤 LFS 指针；下载命中本地 SHA-256 时零网络跳过，force 模式跳过 DB 缓存读取。
9. **D9 趋势与首页 (Trending & Home)**:
   - 趋势抓榜经共享 API 池抓取（doforce 走直连优先、失败经系统代理回退并截断响应体积），结合分档内存与 SQLite 瘦索引快照（`trend_board_cache` 只存排行 id 索引），卡片数据由 `repo_card_cache` 水合，缺失仓由有限批量 enrich 与后台流式 `IconFetch` 补齐（ADR-0014、ADR-0025、ADR-0027）。
   - 精选页展示后端一次组装的推荐货架（`get_featured_page`，ADR-0023）与最近浏览区块；`get_home_feed` 提供固定 `balanced` 排序与日期种子的分页目录接口（ADR-0013）。
10. **D10 统一图标与列表富卡管道 (Unified Icon & Rich-Card Pipeline)**:
    - 后端统一图标补探核心 `fetch_icons_stream` 服务于搜索、趋势、Star 列表与开源广场，各通道持有独立世代计数器互不干扰，命中统一经 `zstore://icon-ready` 发射（level 1–5 与 `via: live | m2` 正交，详见 ADR-0015）。
    - 前端图标写入收口于 `src/services/iconStore.ts`（`useAppSubscriptions` 单一订阅 `zstore://icon-ready` 后按通道门控并扇出列表与镜像）；真实 Tauri 运行时下未缓存图标与正文插图/头像经后端单飞落盘后以 `data:` 渲染，避免前后端双发（ADR-0025）。
    - `Search List Cache` 与 `Repo Enrich Cache` 协同维护有序分页 id 索引与共享富卡池（`data:` 图标进 M1 缓冲，持久化层只存远端 URL 并在读出时叠加确认图标）；详情页走全层级（L1–L4）图标探测。
