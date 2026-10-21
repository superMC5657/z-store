# ADR-0017：本地自维护草稿后端 overlay（custom_apps + 全局合并 + 预填 Issue 链路）

- 状态：Accepted
- 日期：2026-10-16
- 关联：ADR-0009（清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0007（开放清单与 TTL）
- 范围：后端 overlay（SQLite 表、CRUD commands、合并视图 helper、单条与批量预填 Issue 链路）
  + 前端已交付（待收录视图、侧栏导航、全局合并显示、移入入口、设置开关与备份，
  详见 §2.6）。

## 1. 背景

精选收录库走独立生态清单仓库 PR 准入（ADR-0009），社区提交有一段“写条目 → 提交 Issue →
等合入”的空窗期。空窗期内用户希望草稿在本地立即可见、可安装、可管理，
而不是等远端合入后才出现。本地 overlay 满足该需求：草稿先在本地
生效，远端收录后自动退役，全程不碰远端数据文件。

## 2. 决策

1. **新表 `custom_apps`**（`db/schema.rs`，第 17 个 `CREATE TABLE`）：
   `id TEXT PK`（canonical，仅小写 `owner/repo`；本项目只做 GitHub 平台，
   `forge[:host]:owner/repo` 形态不在项目范围）/ `payload_json TEXT`（完整 `CatalogItem` 字段：
   名称、坐标、图标、描述、分类、别名、版本、协议、星数、`is_verified=false`、
   主页、标识符、安装目录、发布者、平台）/ `status TEXT`（`draft`/`submitted`/`collected`（含磁盘残留 `local_collected` 同义，判定唯一口径 `isCollectedStatus`），
   已提交另存 `pr_url`）/ `created_at`/`updated_at` / `archived INTEGER`
   （转正退役标记）。库内归属另有唯一口径 `isLocalLibraryStatus`（收录态 + `submitted`，见 §2.7）。
2. **CRUD commands**（`commands/catalog_custom.rs`）：
   `list_custom_apps`（默认仅未归档）/ `save_custom_app`（暂存档 `DraftLenient`：
   仅校验 `id==canonical` 且与 `owner/repo` 对齐，`license`/`homepage` 可空，
   `name`/`description`/`category` 允许不完整；`is_verified` 强制 false；
   暂存/提交二分法以 ADR-0018 为准）/
   `delete_custom_app`（二次确认由前端做，后端直接删）/
   `mark_submitted(pr_url)`（`status=submitted` + 落链接，已归档拒绝；
   提交档 `SubmitStrict`：必填 + `homepage` http(s) + OSI 门禁，见 ADR-0018）/
   `collect_local_app`（收录档 `CollectStrict` 置 `status=collected`，`is_verified` 恒 false，可搜可装；草稿链路与视图共用的唯一收录命令面）/
   `revert_collected_to_draft`（`collected`→`draft` + 清空 `pr_url`，失败抛错不静默）/
   `withdraw_submitted`（`submitted`→`collected` + 清空 `pr_url`，payload 不动；已归档/非 submitted 拒绝）/
   `retire_on_sync`（远端 id 命中即 `archived=1`，返回转正提示）/
   `get_merged_catalog_view`（合并查询 helper）/ `get_custom_app_pr_url`（单条预填链路入口，
   提交档校验后生成）/ `get_custom_apps_batch_pr_url` + `build_batch_pr_url`（批量预填链路，
   提交档校验后生成）。
3. **全局合并为视图（非写回）**：`CatalogService` 持有远端精选目录 + 本地收录 overlay
   （`collected: RwLock<Vec<CatalogItem>>`，启动与 `custom_apps` 变更后经 `sync_collected_from_db` 同步）；
   `get_catalog_item`/`get_catalog_items`/`is_cataloged`/`get_repo_coordinates`/`search_apps`/
   `merged_summaries` 统一解析远端优先 + 本地收录补位（`get_remote_catalog_items` 保留远端本体口径，
   供清单同步与差异计算），并在投影时盖章 `AppSummary`/`AppDetail` 的
   `source`（`remote`/`local`）与 `is_cataloged`（未收录显式 `false`）。
   `merge_catalog_overlay_view` 把未归档库内条目叠加到内存目录视图；`is_cataloged` 恒 true（视图内即视为已收录），
   来源标记分两处：`AppSummary.source` 为 `remote`/`local`（`local` 为库内行：`status` 为 `collected` 系或 `submitted` 且未归档（库内判定唯一口径 `isLocalLibraryStatus`），库存恒 `is_cataloged=true`、`is_verified=false`，Issue 预填复制体翻 `true` 仅限载荷；提交 Issue 不退出库，只有归档才退出）；`get_merged_catalog_view` 的 `MergedCatalogEntry.source` 另有 `custom`，表示 overlay 补位行（库内条目，草稿不进该视图）；去重远端优先（同 id 取远端行，custom/local 仅补位；远端已存在同仓行叠加 `local` 标记供黄标判定，蓝标优先，已验证不叠加）；收录态 `collected` 与磁盘残留 `local_collected` 同义，`isCollectedStatus` 是「可提交 Issue/可退回」的门禁口径（不含 `submitted`）；本地徽标走 `verified-badge-local` 橘黄（D4 去彩例外，见 CONTEXT 词汇表）。
   现有 `search_apps`/`get_home_feed` 语义不动；视图接线已由前端消费
   （`selectors` 全局合并 + `showCustom` 默认开，关即回退 remote 本体，见 §2.6）。
4. **转正闭环**：`sync_catalog` 成功路径（含本地降级）以远端 id 集合自动退役命中草稿，
   消息尾部追加转正提示（`with_graduation_hint`）；`retire_on_sync` 亦可独立调用
   （`remote_ids=None` 时以当前内存目录为准）。
5. **预填 Issue 链路**：`build_catalog_pr_url` 由草稿 payload 生成清单仓库 Issue 预填 URL
   （标题带 canonical id，正文含关键字段 + 完整 JSON），用户在浏览器确认后提交，
   maintainer 转 PR——草稿“本地先生效、远端后收录”不断链。单条入口为
   `get_custom_app_pr_url` / `get_custom_app_pr_payload`，批量入口为
   `get_custom_apps_batch_pr_url` / `get_custom_apps_batch_pr_payload` /
   `build_batch_pr_url`（提交档校验后生成，门禁口径见 ADR-0018）；payload 命令只返回
   Rust 序列化的 JSON 文本（单对象 / 数组），供预填链接超长时原样复制，前端不拼模板。
   （内部命令与字段仍沿用 `pr_url` 历史命名，仅界面文案称 Issue。）
6. **前端已交付**：待收录页 `PendingView.tsx`
  （+ `PendingView.test.tsx` / `PendingView.pr.test.tsx`、`styles/components-pending.css`，
   Linear 去彩单色）；`App.tsx` 透传 `pendingCount`/`customIds`/`movedInIds`
  （保存/删除/标记提交回调 + `zstore:custom-apps-changed` 刷新）；
   `Sidebar` 待收录导航（`nav.items.pending` + `pendingCount` 角标）；
   `selectors` 全局合并（`selectMergedCatalogApps` + `showCustom` 开关默认开 +
   `annotateIsCataloged` 系列兼容标注：后端投影为权威，客户端仅补齐乐观本地行与旧载荷）；
   `AppCard` 移入入口 + custom 角标；
   `HomeView`/`TrendsView` 移入入口；设置 `show_custom` 开关（默认开）+ 备份
   allowlist 往返（`oauth/backup.rs`）；`ViewType` 新增 `pending`；
   中英双语 pending/custom 文案。
7. **库内归属 × 上游进度（两轴）**：`status` 不是互斥流水线，而是两个维度：
   - 库内归属：`draft`（不在库）→ `collected` 系 / `submitted`（在库）→ `archived`（退出库，权威交还远端）。
   - 上游进度：无 → 已提交 Issue（`submitted`，待收录）→ 已收录（`archived`，转正）。

   提交 Issue 只增加上游进度，不撤销本地可搜可装与黄标。归档是同一 canonical id 的权威切换
   （local → remote）：首页只保留远端一行，黄标转蓝标（远端已验证时），不重复、不闪空，
   本地行不再参与合并/计数/搜索，仅作「已归档」记录留档。
   待收录页收为 3 个 Tab（草稿 / 本地收录 / 已归档），「本地收录」内部按
   全部 / 待提交 / 已提交 分段，计数按 Tab 分区不重计；批量预填只在「待提交」段出现。
   `submitted` 不可重复提交 Issue、不可退回草稿；可「标记为未提交」回到待提交（Issue 需用户自行关闭）。
   已知边界：远端行未验证时归档后无来源徽标（不引入第三徽标）；catalog 后续下架不会回补已归档本地行。

## 3. 为何不用直接改 catalog.json

- `catalog.json` 是种子清单兜底（Catalog Seed Fallback）+ 受检入版本控制的静态文件；
  用户手改会被下次同步覆盖，且改坏即全列表不可用（单点故障）。
- 直接改本地文件绕开了校验（canonical 对齐、必填字段、OSI 协议门禁），脏数据直达渲染层；
  SQLite overlay 在暂存时做 canonical 身份对齐校验（`DraftLenient`），提交时才强制
  全字段 + `homepage` http(s) + OSI 门禁（`SubmitStrict`，暂存/提交二分法以 ADR-0018 为准），
  身份错位的写进不了视图。
- 多设备/备份语义：DB 行随现有用户数据备份走，文件手改不进备份通道。

## 4. 为何用 SQLite 而非文件

- 草稿是用户数据（与收藏/关注/更新规则同类），按 D2 应落本地 SQLite，与现有备份、
  事务（`with_immediate_transaction` 批量退役原子提交）、索引查询（`archived`/`status`
  索引）复用同一套基础设施；另起文件即另起一套并发/损坏恢复机制，不划算。
- 查询形状天然匹配：列表（未归档倒序）、单条、转正批量命中均为一行 SQL；
  文件方案需全量读 + 内存过滤 + 手写锁。
- 状态机（`draft → submitted → archived`）需要原子列更新，SQLite `UPDATE` 即得，
  文件方案需读改写整文件，崩溃易半写。

## 5. 后果

- 正面：空窗期本地立即可见；远端收录后零操作自动归档；校验前置保证视图干净；
  预填链路降低社区投稿门槛。
- 中性：现有列表/搜索命令输出语义不动；合并视图已由前端消费
  （`selectors` 全局合并 + `showCustom` 默认开，关即回退 remote 本体；
  `AppSummary` / `AppDetail` 新增可选 `source` / `status` / `is_cataloged` 字段，
  后端投影即盖章，前端优先读字段；旧载荷与乐观本地行仍由 `selectors` 兼容层补齐，
  缺席时按既有兜底解析）。
- 前端草稿形状唯一来源：领域形状 `DraftItem` / `DraftEntry` 与线格式
  `DraftItemWire` / `DraftEntryWire` 定义于 `src/services/custom/types.ts`，
  两者转换只在 `mappers.ts`（`entryFromWire` / `itemToWire` / `itemToSummary`）；
  `PendingView` 的 `PendingDraftItem` / `CustomDraftEntry` 与 API 客户端的
  `CustomCatalogItem` / `CustomAppEntry` 均为别名，新增字段只改类型与 mapper 一处。
- 风险：草稿详情依赖 `get_repo_coordinates` 的 external_synth 回退（已验证可用）；
  若远端改名（`owner/repo` 变更），旧草稿 id 命中失败而长期残留——后续可加
  “孤儿草稿”提示，当前仅保证不污染视图。


## 6. P2 结论（既有范围，非 scope creep）

- 挂载即 `reloadCustomApps` 保留：`App.tsx` 挂载即拉取本地收录供首页/分类首刷补黄（缺席即无标，就绪后经引用变化重标），避免首刷误终态。
- 趋势计数含本地保留：榜单平台分布按可见行统计，含本地收录行（与黄标同口径）；榜单公信力由蓝优先保障（已验证远端不叠黄），计数口径不单独剔除本地。
- 待收录既有范围接受：`pending_coords_*` 坐标显隐、`supplemental`/`runtime` 折叠、`OpenSource` 占位均为既有范围（缺空态则补空态，不删功能）；后续评审不再计入 scope creep。
