# ADR-0017：本地自维护草稿后端 overlay（custom_apps + 全局合并 + 预填 PR 链路）

- 状态：Accepted
- 日期：2026-10-16
- 关联：ADR-0009（清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0007（开放清单与 TTL）
- 范围：后端 overlay（SQLite 表、CRUD commands、合并视图 helper、单条与批量预填 PR 链路）
  + 前端已交付（待收录视图、侧栏导航、全局合并显示、移入入口、设置开关与备份，
  详见 §2.6；原“视图接线为后续 Lane”已落地，不再是后续项）。

## 1. 背景

精选收录库走独立生态清单仓库 PR 准入（ADR-0009），社区提交有一段“写条目 → 提 PR →
等合入”的空窗期。空窗期内用户希望草稿在本地立即可见、可安装、可管理，
而不是等远端合入后才出现。Lane A 以本地 overlay 满足该需求：草稿先在本地
生效，远端收录后自动退役，全程不碰远端数据文件。

## 2. 决策

1. **新表 `custom_apps`**（`db/schema.rs`，第 15 张核心表）：
   `id TEXT PK`（canonical，仅小写 `owner/repo`；本项目只做 GitHub 平台，
   `forge[:host]:owner/repo` 形态不在项目范围）/ `payload_json TEXT`（完整 `CatalogItem` 字段：
   名称、坐标、图标、描述、分类、别名、版本、协议、星数、`is_verified=false`、
   主页、标识符、安装目录、发布者、平台）/ `status TEXT`（`draft`/`submitted`，
   已提交另存 `pr_url`）/ `created_at`/`updated_at` / `archived INTEGER`
   （转正退役标记）。
2. **CRUD commands**（`commands/catalog_custom.rs`）：
   `list_custom_apps`（默认仅未归档）/ `save_custom_app`（暂存档 `DraftLenient`：
   仅校验 `id==canonical` 且与 `owner/repo` 对齐，`license`/`homepage` 可空，
   `name`/`description`/`category` 允许不完整；`is_verified` 强制 false；
   暂存/提交二分法以 ADR-0018 为准）/
   `delete_custom_app`（二次确认由前端做，后端直接删）/
   `mark_submitted(pr_url)`（`status=submitted` + 落链接，已归档拒绝；
   提交档 `SubmitStrict`：必填 + `homepage` http(s) + OSI 门禁，见 ADR-0018）/
   `retire_on_sync`（远端 id 命中即 `archived=1`，返回转正提示）/
   `get_merged_catalog_view`（合并查询 helper）/ `get_custom_app_pr_url`（单条预填链路入口，
   提交档校验后生成）/ `get_custom_apps_batch_pr_url` + `build_batch_pr_url`（批量预填链路，
   提交档校验后生成）。
3. **全局合并为视图（非写回）**：`CatalogService::merge_catalog_overlay_view`
   把未归档 custom 条目叠加到内存目录视图；`is_cataloged` 恒 true（视图内即视为已收录），
   来源经 `source=remote/custom` 区分；去重远端优先（同 id 取远端行，custom 仅补位）。
   现有 `search_apps`/`get_home_feed` 语义不动；视图接线已由前端消费
   （`selectors` 全局合并 + `showCustom` 默认开，关即回退 remote 本体，见 §2.6）。
4. **转正闭环**：`sync_catalog` 成功路径（含本地降级）以远端 id 集合自动退役命中草稿，
   消息尾部追加转正提示（`with_graduation_hint`）；`retire_on_sync` 亦可独立调用
   （`remote_ids=None` 时以当前内存目录为准）。
5. **预填 PR 链路**：`build_catalog_pr_url` 由草稿 payload 生成清单仓库 Issue 预填 URL
   （标题带 canonical id，正文含关键字段 + 完整 JSON），用户在浏览器确认后提交，
   maintainer 转 PR——草稿“本地先生效、远端后收录”不断链。单条入口为
   `get_custom_app_pr_url`，批量入口为 `get_custom_apps_batch_pr_url` /
   `build_batch_pr_url`（提交档校验后生成，门禁口径见 ADR-0018）。
6. **前端已交付**（原后续 Lane，现已落地为本篇范围）：待收录页 `PendingView.tsx`
  （+ `PendingView.test.tsx` / `PendingView.pr.test.tsx`、`styles/components-pending.css`，
   Linear 去彩单色）；`App.tsx` 透传 `pendingCount`/`customIds`/`movedInIds`
  （保存/删除/标记提交回调 + `zstore:custom-apps-changed` 刷新）；
   `Sidebar` 待收录导航（`nav.items.pending` + `pendingCount` 角标）；
   `selectors` 全局合并（`selectMergedCatalogApps` + `showCustom` 开关默认开 +
   `annotateIsCataloged` 系列标注）；`AppCard` 移入入口 + custom 角标；
   `HomeView`/`TrendsView` 移入入口；设置 `show_custom` 开关（默认开）+ 备份
   allowlist 往返（`oauth/backup.rs`）；`ViewType` 新增 `pending`；
   中英双语 pending/custom 文案。

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
  `AppSummary` 未加字段（`MergedCatalogEntry` flatten 展开，
  前端按 `AppSummary` 解析兼容），custom 行以角标/`source=custom` 区分）。
- 风险：草稿详情依赖 `get_repo_coordinates` 的 external_synth 回退（已验证可用）；
  若远端改名（`owner/repo` 变更），旧草稿 id 命中失败而长期残留——后续 Lane 可加
  “孤儿草稿”提示，本 Lane 仅保证不污染视图。
