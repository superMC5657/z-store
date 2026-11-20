# ADR-0029：开源广场——独立静态清单、置顶推荐边界与零重授权的 Discussions 社交通道

- 状态：Accepted
- 日期：2026-11-16
- 关联：ADR-0006（多托管源 `ForgeProvider`）、ADR-0009（独立生态清单仓库）、ADR-0010（规范应用标识）、ADR-0018（开源协议门禁）、ADR-0020（OAuth 令牌边界）、ADR-0025（动态系统代理与资产缓存收敛；本 ADR 受控扩展其镜像回退范围）、ADR-0027（单仓富卡独立缓存表）
- 修订：§2.2 的置顶边界已调整为允许 Launchpad 顶部 `Spotlight` 赞助位接入经审核的开发者向商业赞助与广告，仍与 `catalog_apps` / 推荐算法物理隔离且保持客户端零埋点。
- 落地计划：`.scratch/feature-launchpad/`、`.scratch/feature-launchpad-preflight-and-badges/`
- 实现：`src-tauri/src/launchpad/`、`src-tauri/src/commands/launchpad.rs`、`src-tauri/src/github/discussions.rs`、`src-tauri/src/db/launchpad.rs`、`src-tauri/src/deeplink.rs`、`src-tauri/config.toml`、`src/views/LaunchpadView.tsx`、`src/views/LaunchpadView/`、`src/components/ShareBadgeModal.tsx`、`src/services/api/launchpad.ts`、`src/demo/handlers/launchpad.ts`；独立数据仓：`superMC5657/z-store-launchpad`（本地 `z:\web_workplace\z-store-launchpad`）

## 1. 背景

独立开发者的新作品进入精选收录库（`z-store-catalog`）需要较长的审核与沉淀期，客户端此前没有面向新品的曝光入口，也没有让用户在应用内为开源作品点 Star、参与讨论的通道。新增入口要同时守住几条既有约束：D1 不引入闭源软件与商业广告、D2 不设中心化后端、精选目录与推荐打分不被新品流污染、现有 OAuth 用户不被要求重新授权。

## 2. 决策

### 2.1 双仓物理隔离

- 广场数据托管在独立公开仓库 `superMC5657/z-store-launchpad` 的 `launchpad.json`（`version: 1`），由 `[launchpad].default_source_url` 指向；不混入 `catalog.json`。
- 客户端只在进入「开源广场」视图或收到 `zstore://launchpad/...` 深链时拉取清单，启动阶段不预取。
- 清单落在独立快照表 `launchpad_feed_cache`（单条 ≤ 512 KiB、最多 3 行、14 天离线窗口），实时讨论计数、本人顶帖态与源仓统计落在 `launchpad_discussion_cache`（最多 500 行、14 天离线窗口，两者均随 `prune_bounded_caches` 清扫，登出清除 `viewer_has_upvoted`）与 `api_etag_cache`；永不写入 `catalog_apps` / `custom_apps`。精选、最新入库、分类、趋势与本地目录搜索都不读广场数据。
- 未收录条目按 ADR-0027 非破坏写入 `repo_card_cache`（已收录跳过、`data:` 图标剥空），点击后复用 `AppDetailModal` + `ForgeProvider` 拉取 Release 与 README，安装仍走 SHA-256 校验与镜像通道。已转正进入目录的条目经 `CatalogService::stamp_summary` 透出收录态；未收录卡片提供「移入待收录」衔接转正流程。
- 上游不可达、返回 429/5xx 或畸形数据时只降级广场视图：回退快照并置 `is_stale`，无快照时页内重试。

### 2.2 D1 与置顶赞助的边界

- 开源广场的免费普通上架流仍面向公开开源仓库、37 项 OSI 协议白名单（与 `[license_gate]` 同源）且含可安装构建资产的开源项目。
- 顶部置顶推荐（`Spotlight`，坑位上限 4 个）为项目的商业赞助展示区：既可展示开源新品置顶，也可接入经维护者人工审核的开发者向商业赞助与广告，用于支持项目可持续维护。商业赞助不写入 `catalog_apps` / `custom_apps`，不参与首页与分类推荐打分，也不污染精选收录库的纯净性。
- `pin_until` 双端过期守卫：数据仓每日工作流撤下到期置顶；客户端解析时对 `pin_until <= now` 的条目实时撤回「最新上架」流，并保证整页同一 `id` 只出现一次。
- 置顶卡片恒带单色 `.status-tag`（`置顶推荐` / `Spotlight` 或赞助标识），保持 Linear 单色视觉克制，不使用彩色实心广告标、弹窗或强干扰广告形式。
- 客户端零行为埋点：不采集、不上报曝光、点击、安装转化或赞助归因。

### 2.3 零重授权的 GitHub Discussions 混合通道

- 现行 `OAUTH_SCOPE = "public_repo user"` 已覆盖公开仓库 Discussions 的读写与 `PUT/DELETE /user/starred`，存量登录用户无需重新授权。
- 已登录：单次 GraphQL 参数化查询（`variables` 绑定，不拼接查询体）取回主帖、顶帖态、30 条评论与每条前 20 条回复（评论总数合并一级评论与二级回复计数）；进入或刷新视图时经 `sync_launchpad_discussions` 按每批 25 条参数化别名 GraphQL 拉取最新讨论顶帖数、评论数、本人顶帖态与 GitHub 源仓统计更新卡片并落入 `launchpad_discussion_cache`；评论经 `addDiscussionComment`，顶帖优先 `addUpvote` / `removeUpvote`，在 `viewerCanUpvote == false` 或 `FORBIDDEN` 时回退 `THUMBS_UP` Reaction，所有读写结果即时写透本地脉冲表。
- 未登录：不调用 GraphQL（避免 401 登录墙），改走匿名 REST + `api_etag_cache` 只读降级（`sync_launchpad_discussions` 按 5 分钟保鲜窗口与有界并发 4 拉取最新评论数，且不以 REST 缺省的原生顶帖字段覆盖已知顶帖数），限流或离线时回退旧载荷，仍无数据则返回带确定性网页地址的空壳与 `auth_required_for_write = true`，前端引导登录或在浏览器参与。
- 讨论仓坐标严格校验为双段 GitHub `owner/repo`，拒绝路径穿越、查询串、锚点、forge 前缀与控制字符。
- 讨论正文与评论统一经 `marked` + `sanitizeHtml` 净化；一键 Star 复用 `star_app` / `unstar_app`，本地 `user_stars` 零网络回填卡片标星态。

### 2.4 镜像回退的受控扩展

ADR-0025 仅允许 `catalog.default_source_url` 经镜像回退。`launchpad.default_source_url` 同为公开、无鉴权的静态清单，纳入同一规则：直连（含系统代理）首跳遭遇传输错误、429 或 5xx，且用户启用了非 `direct` 的 `MirrorNode` 时，经镜像重试一次；镜像不发条件请求、不携带任何令牌，响应必须通过版本与全量规范标识校验才落库，镜像侧 ETag 不落库。

### 2.5 应用内只读投稿预检向导与 README 单色徽章分享器

- **零写权限预检向导（`<LaunchpadSubmitModal>`）**：客户端提供 `preflight_launchpad_submission` 只读预检命令，在提交前现场核验跨托管源仓库可达性、广场/精选重复检测、37 项 OSI SPDX 协议门禁（始终按 `[license_gate]` 白名单口径核验，不受本地草稿放行开关影响）、Release 可安装二进制资产与平台推导、以及 D8 `https://` 自定义图标首包魔数嗅探或自动探测，并在弹窗内直接复用 `<LaunchpadCard>` 实时预览卡片渲染效果。预检通过后仍通过系统浏览器打开预填好表单字段的 `submit-launchpad.yml` GitHub Issue Form，由作者本人确认提交，保持 `OAUTH_SCOPE = "public_repo user"` 不扩大上游仓库写权限。
- **单色徽章与协议深链分享器（`<ShareBadgeModal>`）**：广场卡片与详情页顶栏统一提供分享入口，一键生成 `zstore://launchpad/{id}` / `zstore://app/{id}` 原生协议深链、D4 单色样式（`#111111` / `#f4f4f5`）Shields 徽章及官网着陆页跳转的 Markdown / HTML 嵌入代码（规避 GitHub README 过滤非 `https://` 协议链接）。

## 3. 后果

- 新品曝光、社区互动与精选目录完全解耦，广场故障不影响主应用其他视图。
- 数据仓以 Issue Form + Actions 完成投稿体检、打标上架、Discussion 创建与每日保鲜，维护者只需打标签；所有写清单的工作流共享 `launchpad-json-write` 并发组串行执行。
- 卡片在未登录时可浏览、不可写；顶帖在受限令牌或分类未开投票时以 👍 Reaction 计数，展示口径与 GitHub 网页一致。
- 置顶赞助的对账在仓库外由维护者线下完成，Issue 中只出现订单号或交易尾号。
