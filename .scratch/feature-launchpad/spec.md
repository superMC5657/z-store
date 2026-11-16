# Feature Spec: 开源广场（Launchpad）社交化新品导流分页与零后端上架自动化

> 状态：Implemented
> 关联契约：`CONTEXT.md`（D1 纯粹开源、D2 零服务器成本与解耦清单同步、D3 零信任完整性校验、D4 Linear 去彩单色界面、D5 双池复用、D6 有限并发、D7 有限重试、D10 统一图标获取）、`docs/count-display.md`（数量显示规范）、ADR-0006（多托管源 `ForgeProvider`）、ADR-0009（独立生态清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0018（开源协议门禁）、ADR-0020（OAuth 令牌边界）、ADR-0025（动态系统代理与资产缓存收敛）、ADR-0027（单仓富卡独立缓存表 `repo_card_cache`）。

---

## 1. 核心定位与隔离边界

**开源广场（`Launchpad`）** 是客户端侧栏「发现（`discovery`）」分组下的独立一级视图，面向独立开发者与开源团队提供新锐开源软件的首发曝光、社区互动（一键 Star、GitHub Discussions 评论与 `+1` 顶帖）及一键安装转化通道。

### 1.1 五条硬性隔离不变量

1. **目录物理隔离（Catalog Physical Isolation）**：
   - 广场数据独立托管于外部公开仓库 `superMC5657/z-store-launchpad` 的静态清单 `launchpad.json`，绝不混入 `z-store-catalog` 的 `catalog.json`；
   - 客户端同步 `launchpad.json` 时，**永不写入**本地 SQLite 的 `catalog_apps` 或 `custom_apps` 表；`CatalogService` 驱动的精选发现（`home`）、最新入库（`latest`）、分类浏览（`categories`）、趋势榜（`trends`）与本地目录搜索（`search_apps`）完全不读取广场列表。
2. **未收录富卡与安装链路复用（Uncataloged Pipeline Reuse）**：
   - 尚未进入 `catalog.json` 的广场条目在客户端统一按「未收录应用（`is_cataloged = false`）」处理：卡片元数据非破坏性写入 `repo_card_cache`（遵循 ADR-0027），点击卡片直接复用现有 `AppDetailModal` + `ForgeProvider` 按需直连代码托管源拉取 Release 资产与 README，一键安装完整走 SHA-256 校验（D3）与下载加速镜像通道；
   - 已在广场表现优异并后续转正进入 `z-store-catalog`（或用户本地收录库）的项目，经 `CatalogService::stamp_summary` 自动透出 `is_cataloged = true`（及蓝标/黄标），同时未收录广场卡片提供「移入待收录（`onMoveInApp`）」入口以衔接转正工作流。
3. **故障隔离（Fault Isolation）**：
   - 客户端启动阶段（`lib.rs::setup`）不预拉取 `launchpad.json`，仅在用户切换进入「开源广场」视图（或触发 `zstore://launchpad/...` 深链）时按需请求；
   - 广场清单拥有独立的 SQLite 二级快照表 `launchpad_feed_cache` 与 `api_etag_cache` 条件缓存；即使 `z-store-launchpad` 上游不可达或返回畸形数据，仅广场视图降级使用本地旧快照或展示页内重试提示，不影响主应用任何其他视图。
4. **零自建后端、零行为埋点（Zero Backend & Zero Telemetry）**：
   - 全链路仅依赖静态 JSON（`raw.githubusercontent.com` + 加速镜像回退）与 GitHub 官方 REST / GraphQL API，不设任何中心化后端服务；
   - 客户端不采集、不上报任何曝光、点击、安装转化或赞助位归因埋点。
5. **D1 纯粹开源底线不变（Strictly FLOSS）**：
   - 无论是免费排队的「最新上架」还是付费赞助/精选的「置顶推荐（Spotlight）」，准入仓库均须为公开开源仓库（GitHub / Codeberg / Gitea / GitLab）、具备 OSI 认证开源协议（与 `[license_gate]` 37 项 SPDX 白名单同源）且提供可用 Release 构建资产，严禁闭源软件或商业广告入场。

---

## 2. ADR 契约审查与显式边界说明

按 `docs/agents/domain.md` 规范，核对现有 ADR 与 `CONTEXT.md`：

- **与 D1（禁止商业广告推广）的边界澄清**：D1 严禁闭源专有软件与异业商业广告；开源广场顶部「置顶推荐（Spotlight）」仅向通过同等 FLOSS 协议与构建资产校验的开源项目开放置顶坑位（上限 4 个），且强制携带去彩单色 `.status-tag` 透明标注（`置顶推荐` / `Spotlight`），不介入主收录库与个性化推荐打分。本边界将在实施收口时记入 **ADR-0029**。
- **与 ADR-0020（OAuth 令牌权限范围）的兼容性验证**：客户端现行 `OAUTH_SCOPE = "public_repo user"`（经典 GitHub OAuth App Device Flow）原生具备公开仓库 GitHub Discussions 的 GraphQL 读写权限（`repository.discussion`、`addDiscussionComment`、`addUpvote`/`removeUpvote`、`addReaction`/`removeReaction`）以及 `PUT/DELETE /user/starred/{owner}/{repo}` 权限，**存量已登录用户无需升级权限或重新授权**。
- **与 ADR-0025（下载镜像仅豁免默认收录清单）的受控扩展**：除 `catalog.default_source_url` 外，`launchpad.default_source_url` 同样属于公开无鉴权静态清单 JSON；当直连（含系统代理）首跳遭遇传输错误、HTTP 429 或 5xx 时，允许经当前激活的 `MirrorNode` 重试一次，且必须通过版本与全量 `Canonical App Id` 合法性校验后方可落库，绝不携带任何 Token。

---

## 3. 客户端架构设计（`z-store`）

### 3.1 统一配置中枢扩展（`src-tauri/config.toml` & `src-tauri/src/config.rs`）

在 `src-tauri/config.toml` 新增 `[launchpad]` 配置段（并在 `config.rs` 定义同源默认值结构体 `LaunchpadConfig`）：

```toml
[launchpad]
# 开源广场静态清单默认同步地址（指向独立数据仓 z-store-launchpad）
default_source_url = "https://raw.githubusercontent.com/superMC5657/z-store-launchpad/main/launchpad.json"
# 集中托管新品社区讨论的默认 GitHub 仓库坐标（owner/repo）
discussions_repo = "superMC5657/z-store-launchpad"
# 作者提交作品预填 GitHub Issue Form 地址
submit_issue_url = "https://github.com/superMC5657/z-store-launchpad/issues/new?template=submit-launchpad.yml"
# 官网开源广场投稿说明页地址
submit_web_url = "https://z-store-web.pages.dev/launchpad/submit"
```

### 3.2 视图路由、侧栏导航与深链协议

1. **视图注册（`src/types/index.ts` & `src/components/Sidebar.tsx`）**：
   - `VIEW_TYPES` 扩展为：`['home', 'latest', 'categories', 'trends', 'launchpad', 'pending', 'favorites', 'installed', 'settings']`；
   - 归属 `discovery`（发现）分组，位于 `trends`（趋势）之后、`pending`（待收录）之前；
   - 导航文案：`zh-CN` 为 `"开源广场"`，`en-US` 为 `"Launchpad"`；
   - 导航图标：采用单色线性矢量扩音器图标（`Megaphone` 风格 24×24，`strokeWidth="1.5"`，适配 `currentColor`，避免与 `trends` 已占用的火箭图标重复）；
   - 侧栏导航项本身作为发现入口不挂常驻数字角标；进入视图后通过 `onDisplayPlatformCounts`（`handleLaunchpadPlatformCounts`）向侧栏「平台」6 枚芯片上报广场全量条目的平台分布，离开视图自动恢复全库分布。
2. **协议深链（`src-tauri/src/deeplink.rs` & `src/app/hooks/useDeepLink.ts`）**：
   - `zstore://view/launchpad` 或 `zstore://launchpad` → 解析为 `DeepLinkAction::OpenView { view: "launchpad" }`，直达开源广场分页；
   - `zstore://launchpad/{app_id}`（如 `zstore://launchpad/acme/hyper-term`）→ 新增 `DeepLinkAction::LaunchpadApp { app_id }`（入站经 `forge::canonical_lookup_id` 归一化）：客户端切至 `launchpad` 视图，自动高亮定位对应新品卡片并打开其应用详情弹窗（绝不自动触发安装，供作者在社交媒体、README 与 Release 中安全传播）。

### 3.3 页面结构、排序算法与数量显示规范

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [Megaphone] 开源广场                                 [+ 提交我的开源作品] │
│ 发现独立开发者的新锐开源作品，点亮 Star 与参与讨论，助力好工具被看见       │
├──────────────────────────────────────────────────────────────────────────┤
│ ★ 置顶推荐  [CountBadge: 3]                           （无有效置顶时隐藏）│
│ ┌─────────────────────────────────┐ ┌─────────────────────────────────┐  │
│ │ [Icon] HyperTerm  [置顶推荐]    │ │ [Icon] NoteFlow   [置顶推荐]    │  │
│ │ @acme (头像可点→开发者主页)     │ │ @linus-dev                      │  │
│ │ “重写了 WebGPU 渲染管线...”      │ │ “纯本地双向链接笔记...”          │  │
│ │ [Win][Mac][Linux] v0.4.2 本周+135│ │ [Win][Linux] v1.1.0   2 天前上架 │  │
│ │ [▲ 64] [💬 18] [☆ 420]   [获取] │ │ [▲ 29] [💬 9]  [★ 180]   [获取] │  │
│ └─────────────────────────────────┘ └─────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────┤
│ 最新上架  [CountBadge: 24]             Segmented: [ 推荐 | 最新上架 | 讨论热度 ] │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ 新品流卡片网格（排除当前仍在有效置顶期内的 Spotlight 条目，同页不重出）│ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **顶部「置顶推荐（Spotlight）」区**：
   - 坑位上限硬约束：`SPOTLIGHT_MAX_SLOTS = 4`（常规运营 2~4 个；当有效未过期置顶数为 `0` 时整块隐藏，不留空壳）；
   - 双重过期守卫：除外部仓库每日定时 Actions 清理外，客户端 Rust 解析层对 `pinned` 数组中 `pin_until <= now_secs` 的条目实时判定为已过期，自动撤出 Spotlight 并归入下方「最新上架」普通流；
   - 去重原则：仍在有效置顶期内的项目仅在顶部 Spotlight 区展示，不在下方「最新上架」流重复出现（整页同一 `id` 只出现一次）；
   - 单色透明标注：每张置顶卡片挂载 `.status-tag`（`components-status-tag.css`），文案为 `置顶推荐` / `Spotlight`（严格遵守 D4 去彩单色规范，禁止彩色实心广告标）。
2. **下方「最新上架（Recent Launches）」流与三档排序**：
   - 分段控制器 `<SegmentedControl<LaunchpadSortMode>>` 支持三档切换（切换排序不改变匹配集合大小）：
     - `recommended`（**推荐**，默认）：兼顾首发新锐度、社区顶帖/讨论互动与近期涨星脉冲的时间衰减热度分：
       $$\text{score} = \frac{10.0 + 3.0\ln(1 + \text{upvotes}) + 2.5\ln(1 + \text{comments}) + 2.0\ln(1 + \max(0, \Delta\text{stars}_{7d})) + 0.5\ln(1 + \text{stars})}{(1 + \max(0, \text{age\_days}) / 7.0)^{1.2}}$$
       并列时按 `launched_at DESC`、`id ASC` 决胜；
     - `latest`（**最新上架**）：严格按 `launched_at DESC`、`stars DESC`、`id ASC` 排列；
     - `discussions`（**讨论热度**）：按 `(discussion_comments_count * 2 + discussion_upvotes) DESC`、`launched_at DESC`、`id ASC` 排列。
3. **数量显示与全局设备平台过滤对齐（`docs/count-display.md`）**：
   - 顶部 Spotlight 与下方 Recent Launches 均严格响应侧栏全局 `selectedPlatforms` 多选过滤（平台未知加载中行沿用 `isPlatformLoading` 守卫，已确认无安装包资产归入虚拟 `other`）；
   - 「置顶推荐」标题挂 `<CountBadge value={visibleSpotlight.length} />`；「最新上架」标题挂 `<CountBadge value={visibleRecent.length} />`（仅在 `!loading && !error` 时渲染）；三档排序分段标签不重复挂同一数字，满足「一个视图里每个数字只出现一次」；
   - 当广场原始列表非空但被 `selectedPlatforms` 全部筛空（`visibleSpotlight.length === 0 && visibleRecent.length === 0`）时，渲染带「重置设备筛选」按钮的 `<FilterEmptyState>`。
4. **右上角常驻「提交我的开源作品」入口**：
   - 页头右侧常驻次级主操作按钮，点击展开轻量 `<FlyoutMenu>`（键盘可达，`Esc` 关闭）：
     - **GitHub Issue 快速投稿（推荐）**：调用 `tauriApi.openUrl(submitIssueUrl)` 打开预结构化的 `submit-launchpad.yml` 表单；
     - **官网投稿与置顶说明**：调用 `tauriApi.openUrl(submitWebUrl)` 跳转官网说明页。

### 3.4 社交化交互与 IPC 数据契约

#### 3.4.1 清单拉取与缓存水合（`get_launchpad_feed`）

- **连接池与代理边界**：复用无 Token 公开静态清单客户端（同 `CatalogService::http_client`，跟随系统动态代理快照 `ProxySnapshot`，绝不附带 OAuth/PAT 凭据）；直连 `launchpad.default_source_url` 携带 `api_etag_cache` 中的 `If-None-Match`：
  - `304 Not Modified` → 直接读取 SQLite `launchpad_feed_cache` 快照，0ms 解析返回；
  - `200 OK` → 校验 JSON 结构（`version == 1`，条目 `id` 经 `canonical_app_id` 校验，剥离任何 `data:` 图标），单事务更新 `api_etag_cache`、`launchpad_feed_cache`，并将未收录条目非破坏性写入 `repo_card_cache`；
  - 传输失败 / 429 / 5xx → 若当前使用的是默认官方源且已启用非 `direct` 的 `MirrorNode`，经加速镜像前缀重试一次并执行严格校验；仍失败则回退 `launchpad_feed_cache` 本地快照并置 `is_stale = true`。
- **本地状态零网络叠加**：后端组装 `LaunchpadEntry` 时，单锁批量叠加：
  1. `CatalogService::stamp_summary`（标记 `is_cataloged`、`is_verified`、`source`）；
  2. `resolve_confirmed_icon_from_db`（叠加本地已缓存的确认图标 `data:` URI）；
  3. 当存在活跃 GitHub 登录态时，从本地 `user_stars` 表零网络回填 `viewer_has_starred: bool`（杜绝进入广场时对 N 张卡片并发打 N 次 `/user/starred` API）；
  4. 对无图标且无确认图标的 GitHub 条目，后台异步触发独立世代 `IconFetchCtx::Launchpad { gen }` 流式补图（`zstore://icon-ready`）。

#### 3.4.2 一键 Star（复用 `star_app` / `unstar_app`）

- **GitHub 托管源（`forge == "github"`）**：
  - 卡片底部渲染可交互 Star 按钮（显示 `viewer_has_starred` 实心金星 `#eab308` 或单色空心星 + `formatStars(stars)`）；
  - 未登录或登录已过期（`!oauthUser || oauthUser.is_expired`）时点击：弹出温和提示 Toast 并引导打开设置页账号卡片（`#settings-account`）；
  - 已登录点击：调用既有 `tauriApi.starApp(id)` / `tauriApi.unstarApp(id)`，乐观/确认翻转按钮状态并增减展示星数，自动同步本地 `user_stars` 与用户亲和度画像。
- **非 GitHub 托管源（Codeberg / Gitea / GitLab）**：
  - 自动降级：仅静态展示星数标签（若 `stars > 0`），不展示交互式 GitHub Star 按钮，改由托管源徽标/外链按钮引导通过 `tauriApi.openUrl` 访问源仓库。

#### 3.4.3 应用内社区评论与 `+1` 顶帖（GitHub Discussions 混合通道）

每款广场新品关联 `(discussion_repo, discussion_number, discussion_node_id?, discussion_url)`（默认集中托管于 `superMC5657/z-store-launchpad` 的 `Launches` 分类，亦兼容指向作者自有 GitHub 仓库的关联 Discussion）：

1. **`get_launchpad_discussion`（读取讨论串与评论分页）**：
   - 参数：`discussion_repo: String`, `discussion_number: u64`, `cursor: Option<String>`, `force_refresh: Option<bool>`（前端传 `discussionRepo`, `discussionNumber`, `cursor`, `forceRefresh`）；
   - **已登录路径（持有活跃 GitHub Token）**：单次 `POST https://api.github.com/graphql` 参数化查询（严禁拼接 GraphQL 字符串），一次取回主帖正文、作者、`upvoteCount`、`viewerCanUpvote`、`viewerHasUpvoted`、`THUMBS_UP` `reactionGroups`、评论总数、分页游标 `endCursor` 及前 30 条评论（含每条评论的前 20 条二级回复 `replies`）；
   - **未登录降级路径（无 Token，避免 GraphQL 401 登录墙）**：经 `get_with_etag` 请求 `https://api.github.com/repos/{owner}/{repo}/discussions/{number}` 与 `/comments?per_page=30`（接入 `api_etag_cache` 304 缓存），返回只读讨论内容并置 `auth_required_for_write = true`；若匿名配额受限，抽屉平滑展示静态计数与「在 GitHub 查看讨论 / 登录参与互动」入口。
2. **`add_launchpad_comment`（发表评论或回复）**：
   - 参数：`discussion_repo: String`, `discussion_number: u64`, `discussion_id: Option<String>`, `body: String`, `reply_to_id: Option<String>`；
   - 校验登录态与正文长度（`1..=10000` 字符），若缺 `discussion_id` 先经 GraphQL 查询节点 ID，再执行 `addDiscussionComment` Mutation，返回新评论实体就地追加至抽屉列表，并使当前卡片评论计数 `+1`。
3. **`toggle_launchpad_upvote`（投 `+1` 顶帖 / 取消顶帖）**：
   - 参数：`discussion_repo: String`, `discussion_number: u64`, `subject_id: Option<String>`, `currently_upvoted: bool`；
   - 若 `launchpad.json` 已携带 `discussion_node_id`（即 `subject_id`），卡片上点击 `+1` **无需先拉取详情即可单次 GraphQL 往返完成顶帖**；
   - 优先执行原生 `addUpvote` / `removeUpvote` Mutation；若返回 `viewerCanUpvote == false` 或 `FORBIDDEN`（例如用户使用受限细粒度令牌或目标分类未开投票），自动无缝回退至 `addReaction(content: THUMBS_UP)` / `removeReaction(content: THUMBS_UP)`，保证 `+1` 顶帖体验始终可靠。
4. **安全渲染与作者联动**：
   - 讨论区正文与评论 Markdown 统一经 `marked` + `sanitizeHtml`（`src/utils/sanitize.ts`）AST 白名单净化，阻断一切脚本、内联事件与非光栅 `data:` URI；
   - 卡片作者栏与评论区所有用户头像统一使用 `<CachedAvatar>`（经后端 `fetch_or_cache_asset_url` 缓存），点击作者头像/句柄（`@login`）直接呼起既有 `<DeveloperProfileModal>`。

#### 3.4.4 新增 IPC 命令汇总（严格遵守 `AGENTS.md` 命名规范）

| Rust 命令名 (`lib.rs`) | 前端 `CMD` 键 | 前端请求参数 (`camelCase`) | 后端响应模型 (`snake_case` 字段) |
|---|---|---|---|
| `get_launchpad_feed` | `getLaunchpadFeed` | `{ forceRefresh?: boolean }` | `LaunchpadFeedResponse` (`spotlight`, `items`, `discussions_repo`, `submit_issue_url`, `submit_web_url`, `generated_at`, `cached_at`, `is_stale`) |
| `get_launchpad_discussion` | `getLaunchpadDiscussion` | `{ discussionRepo, discussionNumber, cursor?, forceRefresh? }` | `LaunchpadDiscussionDetail` (`id`, `number`, `title`, `body`, `url`, `created_at`, `locked`, `closed`, `author`, `category_name`, `upvote_count`, `viewer_has_upvoted`, `viewer_can_upvote`, `viewer_can_comment`, `auth_required_for_write`, `comments_total`, `has_next_page`, `end_cursor`, `comments`, `is_stale`) |
| `add_launchpad_comment` | `addLaunchpadComment` | `{ discussionRepo, discussionNumber, discussionId?, body, replyToId? }` | `LaunchpadDiscussionComment` (`id`, `body`, `created_at`, `author_association`, `author`, `upvote_count`, `viewer_has_upvoted`, `replies`) |
| `toggle_launchpad_upvote` | `toggleLaunchpadUpvote` | `{ discussionRepo, discussionNumber, subjectId?, currentlyUpvoted }` | `LaunchpadUpvoteResult` (`subject_id`, `upvote_count`, `viewer_has_upvoted`, `mode`) |

---

## 4. 外部数据仓架构设计（`superMC5657/z-store-launchpad`）

### 4.1 仓库目录布局

```text
z-store-launchpad/
├── launchpad.json                              # 客户端消费的静态广场清单（SSOT）
├── state/
│   └── stars-history.json                      # 近 14 天每日星数滚动快照，用于计算 stars_7d_delta
├── schema/
│   └── launchpad.schema.json                   # Draft 2020-12 严格 Schema 定义
├── scripts/
│   ├── validate-launchpad.mjs                  # JSON Schema + 业务不变量校验脚本
│   ├── verify-submission.mjs                   # Issue Form 解析 + 仓库/OSI 协议/Release 资产探测
│   ├── publish-launch.mjs                      # 准入写入 + 创建 Discussion + 生成深链回复
│   ├── refresh-pulse-and-pins.mjs              # 每日 pin_until 过期降级 + 社交脉冲更新
│   └── bootstrap-repo.sh                       # 维护者初始化标签与 Discussions 分类辅助脚本
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── config.yml
│   │   └── submit-launchpad.yml                # 结构化新品投稿 Issue Form
│   └── workflows/
│       ├── validate-submission.yml             # 投稿自动预审与预览回复
│       ├── publish-launch.yml                  # 打标自动上架、建 Discussion、回填深链并关单
│       ├── expire-pins-and-pulse.yml           # 每日定时撤下到期置顶 + 刷新 Star/讨论热度
│       └── validate-schema.yml                 # PR / Push 清单格式门禁
└── README.md
```

### 4.2 `launchpad.json` 数据契约（`version: 1`）

- **顶层字段**：
  - `version`: 固定整数 `1`；
  - `generated_at`: ISO-8601 UTC 字符串；
  - `discussions_repo`: 默认集中讨论仓 `"superMC5657/z-store-launchpad"`；
  - `pinned`: 置顶槽位数组（长度 `0..=4`），每项 `{ id, pin_until, pin_tier: "sponsor" | "featured", pin_order }`，`id` 必须引用 `items` 中已存在的规范标识；
  - `items`: 新品完整元数据数组（按 `launched_at DESC, id ASC` 稳定排列），单条包含：
    - 仓库与展示基础字段：`id`（小写规范坐标）、`name`、`owner`、`repo`、`forge`、`forge_host`、`icon`（仅允许空串或 `https://`，禁 `data:`）、`icon_bg`、`description`、`description_en?`、`category`、`category_name`、`license`、`latest_version`、`latest_release_at?`、`platforms`（五端枚举数组）、`homepage?`；
    - 作者与自荐字段：`maker_note`（必填，`1..=140` 字符单行自荐语）、`maker_note_en?`、`maker: { login, name?, avatar_url, html_url }`；
    - 社交脉冲与讨论绑定字段：`launched_at`（ISO-8601）、`stars`、`stars_7d_delta`、`forks`、`discussion_repo`、`discussion_number`、`discussion_node_id?`、`discussion_url`、`discussion_comments_count`、`discussion_upvotes`。

### 4.3 作者投稿与维护者一键上架自动化工作流

1. **Step 1 — 结构化投稿（`submit-launchpad.yml`）**：
   - 必填项：开源仓库地址（支持 GitHub / Codeberg / Gitea / GitLab）、应用显示名称、一句话作者自荐语（`maker_note`，限 140 字）、功能分类下拉框、上架档位选择（`free` 免费新品池 / `spotlight-7d` / `spotlight-14d` / `spotlight-30d`）；
   - 可选项：英文自荐语（`maker_note_en`）、自定义透明图标直链（`https://`）、项目主页、关联自有仓库已有 Discussion 编号、第三方赞助凭证单号脱敏尾号（表单明确提示严禁粘贴任何私钥或支付敏感隐私，完整对账仅由维护者线下核验后打标确认）。
2. **Step 2 — Actions 自动预检（`validate-submission.yml`）**：
   - 监听 `issues: [opened, edited, reopened]`（带 `launchpad-submission` 标签）；
   - 自动解析表单字段，调用对应托管源公开 API 核验：
     - 仓库公开可访问、非 Fork（或明确独立发行）、非 Archived；
     - SPDX 开源协议命中 ZStore 37 项 OSI 白名单（`NOASSERTION` / 闭源协议直接标红拦截）；
     - 最新 Release 存在且包含至少 1 个有效构建资产，自动推导支持平台 `platforms` 与 `latest_version`；
   - 将结构化体检报告与卡片预览以评论形式回复至 Issue，全部通过自动打 `validated` 标签，未通过打 `needs-changes` 标签并列出具体修复项。
3. **Step 3 — 维护者打标即自动上架（`publish-launch.yml`）**：
   - 监听 `issues: [labeled]`，仅响应仓库维护者打上的准入标签：`approved`（免费上架）、`pinned-7d`、`pinned-14d`、`pinned-30d`、`featured-7d`；
   - 使用 `concurrency: { group: launchpad-json-write, cancel-in-progress: false }` 串行化写库，防止并发打标产生 Git 冲突；
   - 若为置顶标签（`pinned-*` / `featured-*`），先扫描当前未过期的 `pinned` 坑位数：若已满 `4` 个，拒绝覆盖他人坑位，自动在 Issue 评论最早释放时间并中止本次置顶写入；
   - 若条目尚未绑定 Discussion，通过 GraphQL `createDiscussion` 在 `z-store-launchpad` 的 `Launches` 分类下自动创建专属讨论帖（标题 `{name} ({owner}/{repo}) — {maker_note}`，正文含应用简介、支持平台与 `zstore://` 唤醒链接），取回 `number`、`id`（`discussion_node_id`）与 `url`；
   - 幂等更新 `launchpad.json`（同 `id` 二次上架刷新版本与自荐语，不造重复行）并推送到 `main`；
   - 在 Issue 下自动回复作者专属传播物料包（含 `zstore://launchpad/{id}` 广场直达深链、`zstore://app/{id}` 详情深链、Discussion 链接与 README Markdown 徽章代码），随后自动关闭 Issue（`state_reason: completed`）。
4. **Step 4 — 每日置顶到期撤下与热度保鲜（`expire-pins-and-pulse.yml`）**：
   - 每日 UTC `00:15` 定时运行（支持 `workflow_dispatch` 手动触发），共享 `launchpad-json-write` 并发锁；
   - 扫描 `pinned` 数组：凡 `pin_until <= now` 的条目自动移出 `pinned`（其 `items` 本体原样保留，无缝降级回普通新品流）；
   - 批量刷新在架项目的公开 `stars`、`forks`、`latest_version`、`discussion_comments_count`、`discussion_upvotes`，结合 `state/stars-history.json` 计算滚动 7 日增量 `stars_7d_delta`，仅当数据发生实质变化时提交一次干净 Commit。

---

## 5. 实施 Issue 拆分与依赖拓扑

```text
  [客户端主仓 z-store]                                    [外部数据仓 z-store-launchpad]
  ────────────────────                                    ──────────────────────────────
  [01 配置、SQLite 快照与广场清单同步引擎]                [06 launchpad.json Schema 与投稿 Issue Form]
            │                                                           │
            ▼                                                           ▼
  [02 GitHub Discussions 评论与 +1 顶帖 IPC]              [07 自动校验、打标上架与置顶过期 Actions 工作流]
            │
            ▼
  [03 前端类型、API、深链与 Demo Mock 对齐]
            │
            ▼
  [04 侧栏入口、LaunchpadView 双区视图与 Star/画像联动]
            │
            ▼
  [05 应用内 Discussion 评论顶帖抽屉与未登录降级闭环]
            │
            ▼
  [08 ADR-0029、领域文档同步与全量回归门禁验收]
```

1. [`01-launchpad-config-schema-and-feed-sync.md`](./issues/01-launchpad-config-schema-and-feed-sync.md)（`ready-for-agent`，`Blocked by: none`）
2. [`02-github-discussions-ipc-and-upvote.md`](./issues/02-github-discussions-ipc-and-upvote.md)（`ready-for-agent`，`Blocked by: 01`）
3. [`03-frontend-types-ipc-deeplink-and-demo-mock.md`](./issues/03-frontend-types-ipc-deeplink-and-demo-mock.md)（`ready-for-agent`，`Blocked by: 01, 02`）
4. [`04-sidebar-and-launchpad-view-ui.md`](./issues/04-sidebar-and-launchpad-view-ui.md)（`ready-for-agent`，`Blocked by: 03`）
5. [`05-in-app-discussion-drawer-and-social-loop.md`](./issues/05-in-app-discussion-drawer-and-social-loop.md)（`ready-for-agent`，`Blocked by: 04`）
6. [`06-external-launchpad-repo-schema-and-issue-form.md`](./issues/06-external-launchpad-repo-schema-and-issue-form.md)（`ready-for-agent`，`Blocked by: none`）
7. [`07-external-launchpad-github-actions-workflows.md`](./issues/07-external-launchpad-github-actions-workflows.md)（`ready-for-agent`，`Blocked by: 06`）
8. [`08-docs-adr-0029-and-regression-gates.md`](./issues/08-docs-adr-0029-and-regression-gates.md)（`ready-for-agent`，`Blocked by: 04, 05`）

---

## 6. 整体验收标准

- **隔离性与稳健性**：
  - 浏览、刷新开源广场或安装广场未收录应用后，`catalog_apps` 与 `custom_apps` 行数及内容零污染；`home` / `latest` / `categories` / `trends` 行为完全不受影响；
  - 模拟 `launchpad.default_source_url` 断网、500 或返回非法 JSON 时，主程序正常启动使用，广场页优先展示 `launchpad_feed_cache` 离线快照（标注 `is_stale`），无快照时展示独立重试态；`If-None-Match` 命中 `304` 时零重复下载解析；
  - `pin_until` 过期的置顶条目在客户端读取与远端定时任务两侧均被可靠移出 Spotlight 并归入下方普通新品流，且同屏绝不重复渲染同一应用。
- **社交闭环与界面规范**：
  - 顶部 Spotlight（限 2~4 坑位，无置顶时隐藏）卡片携带去彩单色 `.status-tag`（`置顶推荐` / `Spotlight`）、作者自荐语、支持平台、版本号与一键安装；下方新品流支持 `推荐 / 最新上架 / 讨论热度` 切换；右上角常驻投稿入口可用；
  - GitHub 源卡片支持一键 Star / 取消 Star（复用 OAuth `star_app` / `unstar_app`），非 GitHub 源优雅降级为跳源仓；点击作者或评论者头像直接呼起 `DeveloperProfileModal`；
  - 应用内 `LaunchpadDiscussionDrawer` 支持查看 Markdown 讨论（经 `sanitizeHtml` 净化）、发表评论/回复、投 `+1` 顶帖（`addUpvote` 主路径 + `THUMBS_UP` Reaction 兜底），未登录用户可免报错浏览降级内容并获清晰登录引导；
  - 深链 `zstore://view/launchpad` 与 `zstore://launchpad/{owner}/{repo}` 准确唤醒并定位。
- **工程质量门禁**：
  - 100% 通过 `countDisplay.test.ts`、`ipcArgsNaming.test.ts`、`cmdAlignment.test.ts`、`noDirectInvoke.test.ts`、`components.i18n.scan.test.ts`、`buttons.parity.test.tsx`；
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npx tsc --noEmit`、`npx vitest run`、`npx vite build --config vite.demo.config.ts` 全部零错误通过；
  - 外部 `z-store-launchpad` 仓库 Schema 校验器与四条 GitHub Actions 脚本单测全部通过。
