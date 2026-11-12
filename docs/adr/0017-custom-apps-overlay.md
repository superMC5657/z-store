# ADR-0017：本地自维护草稿后端 overlay（custom_apps + 全局合并 + 预填 Issue 链路）

- 状态：Accepted
- 日期：2026-10-16
- 关联：ADR-0009（清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0007（开放清单与 TTL）
- 范围：后端 overlay（SQLite 表、CRUD commands、单条预填 Issue 链路）
  + 前端（待收录视图、侧栏导航、全局合并显示、移入入口、设置开关与备份，
  详见 §2.6）。

## 1. 背景

精选收录库走独立生态清单仓库 PR 准入（ADR-0009），社区提交有一段“写条目 → 提交 Issue → 等合入”的空窗期。本地 overlay 让草稿在空窗期内立即可见、可安装与可管理，远端收录后自动归档，全程不直接修改内置与同步后的生态数据文件。

## 2. 决策

1. **存储表 `custom_apps`**（`db/schema.rs`）：
   `id TEXT PK`（canonical，仅小写 `owner/repo`；待收录草稿当前仅支持 GitHub 仓库，`forge:` 前缀形态不在待收录范围）/ `payload_json TEXT`（完整 `CatalogItem` 字段：名称、坐标、图标、描述、分类、别名、版本、协议、星数、`is_verified=false`、主页、标识符、安装目录、发布者、平台）/ `status TEXT`（`draft`/`submitted`/`collected`，其中判定函数 `isCollectedStatus` 同时兼容 `local_collected` 同义值；已提交另存 `pr_url`）/ `created_at`/`updated_at` / `archived INTEGER`（转正退役标记）。库内归属另有唯一口径 `isLocalLibraryStatus`（收录态 + `submitted`，见 §2.7）。
2. **CRUD commands**（`commands/catalog_custom.rs`）：
   - `list_custom_apps`（默认仅返回未归档条目）；
   - `save_custom_app`（暂存档 `DraftLenient`：仅校验 `id==canonical` 且与 `owner/repo` 对齐，`license`/`homepage` 可空，`name`/`description`/`category` 允许不完整；`is_verified` 强制 false；暂存/提交二分法以 ADR-0018 为准）；
   - `delete_custom_app`（二次确认由前端负责，后端直接删除）；
   - `mark_submitted(pr_url)`（`status=submitted` + 落链接，已归档拒绝；提交档 `SubmitStrict`：必填 + `homepage` http(s) + OSI 门禁，见 ADR-0018）；
   - `collect_local_app`（收录档 `CollectStrict` 置 `status=collected`，`is_verified` 恒 false，可搜可装；草稿链路与视图共用的唯一收录命令面）；
   - `revert_collected_to_draft`（`collected`→`draft` + 清空 `pr_url`，失败抛错不静默）；
   - `withdraw_submitted`（`submitted`→`collected` + 清空 `pr_url`，payload 保持不变；已归档/非 submitted 拒绝）；
   - `get_custom_app_pr_url` / `get_custom_app_pr_payload`（单条预填链路入口，提交档校验后生成 Issue 预填链接与原始 JSON 载荷）。
3. **全局合并为视图（非写回）**：`CatalogService` 持有远端精选目录 + 本地收录 overlay（`collected: RwLock<Vec<CatalogItem>>`，启动与 `custom_apps` 变更后经 `sync_collected_from_db` 同步）；`get_catalog_item`/`get_catalog_items`/`is_cataloged`/`get_repo_coordinates`/`search_local_catalog`/`merged_summaries` 统一遵循远端优先 + 本地收录补位（`get_remote_catalog_items` 提供远端本体口径供清单同步与差异计算），并在投影时盖章 `AppSummary`/`AppDetail` 的 `source`（`remote`/`local`）与 `is_cataloged`（未收录显式 `false`）。
   来源标记以 `AppSummary.source` 表达（`remote`/`local`）：`local` 为未归档库内行（`status` 满足 `isLocalLibraryStatus`），库存恒 `is_cataloged=true`、`is_verified=false`（Issue 预填复制体翻 `true` 仅限外发载荷）；去重远端优先（同 id 取远端行，本地仅补位；远端已存在同仓未验证行可叠加 `local` 标记供黄标判定，已验证蓝标优先不叠加）。前端 `selectors` 执行全局合并与 `showCustom` 开关（默认开，关闭回退 remote 本体，见 §2.6）。
4. **转正闭环**：`sync_catalog` 成功路径（含本地降级）自动调用 `db.retire_custom_apps_on_sync` 将命中远端 id 集合的未归档草稿置为 `archived=1`，并在同步消息尾部追加转正提示（`with_graduation_hint`）。
5. **预填 Issue 链路**：`build_single_pr_url` 由草稿 payload 生成清单仓库 Issue 预填 URL（标题带 canonical id，正文含关键字段 + 完整 JSON），用户在浏览器确认后提交，maintainer 转 PR 收录。入口为 `get_custom_app_pr_url` / `get_custom_app_pr_payload`（提交档校验后生成，门禁口径见 ADR-0018）；payload 命令返回 Rust 序列化的单对象 JSON 文本，供预填链接超长时原样复制，前端不拼接模板。（内部命令与字段沿用 `pr_url` 命名，界面文案呈现为 Issue。）
6. **前端接线**：待收录页 `PendingView.tsx`（及 `views/pending/*` 子组件、`styles/components-pending.css`，Linear 去彩单色）；`App.tsx` 透传 `pendingCount`/`customIds`/`movedInIds`（保存/删除/标记提交回调 + `zstore:custom-apps-changed` 刷新）；`Sidebar` 待收录导航（`nav.items.pending` + `pendingCount` 角标）；`selectors` 全局合并（`selectMergedCatalogApps` + `showCustom` 开关默认开 + `annotateIsCataloged` 系列兼容标注：后端投影为权威，客户端补齐乐观本地行）；`AppCard` 移入入口 + custom 角标；`HomeView`/`TrendsView` 移入入口；设置 `show_custom` 开关（默认开）+ 备份 allowlist 往返（`userdata/mod.rs::IMPORT_SETTINGS_ALLOWLIST`）；`ViewType` 包含 `pending`；中英双语 pending/custom 文案。
7. **库内归属 × 上游进度（两轴）**：`status` 对应两个正交维度：
   - 库内归属：`draft`（不在库）→ `collected` 系 / `submitted`（在库）→ `archived`（退出库，权威交还远端）。
   - 上游进度：无 → 已提交 Issue（`submitted`，待收录）→ 已收录（`archived`，转正）。

   提交 Issue 只增加上游进度，不撤销本地可搜可装与黄标。归档是同一 canonical id 的权威切换（local → remote）：首页只保留远端一行，远端已验证时呈蓝标，不重复、不闪空，本地行退出合并/计数/搜索，仅在「已归档」留档。
   待收录页分为 3 个 Tab（草稿 / 本地收录 / 已归档），「本地收录」内部分为 全部 / 待提交 / 已提交 分段，计数按 Tab 分区不重计。`submitted` 不可重复提交 Issue、不可退回草稿；可「标记为未提交」回到待提交（Issue 需用户自行关闭）。
   已知边界：远端行未验证时归档后无来源徽标（不引入第三徽标）；catalog 下架条目不回补已归档本地行。

## 3. 为何不直接改 catalog.json

- `catalog.json` 是种子清单兜底（Catalog Seed Fallback）与受版本控制的静态文件；直接修改会在下次同步时被覆盖，且格式损坏会导致列表不可用。
- 直接改本地文件绕开了校验（canonical 对齐、必填字段、OSI 协议门禁）；SQLite overlay 在暂存时执行 canonical 身份对齐校验（`DraftLenient`），提交时强制全字段 + `homepage` http(s) + OSI 门禁（`SubmitStrict`，见 ADR-0018），确保脏数据不进入视图。
- 备份一致性：DB 行随用户数据备份导入导出流转。

## 4. 为何用 SQLite 而非独立文件

- 草稿与收藏/关注/更新规则同属用户数据，复用 `z_store.db` 的事务（`with_immediate_transaction` 批量退役原子提交）、索引查询（`archived`/`status`）与备份能力，无需额外维护并发与损坏恢复机制。
- 查询与状态流转匹配：列表查询、单行读取、转正批量命中以及 `draft → submitted → archived` 原子列更新均通过 SQLite 事务完成。

## 5. 后果

- 正面：空窗期本地立即可见与可用；远端收录后自动归档；校验前置保证视图干净；单条 Issue 预填降低投稿门槛。
- 中性：合并视图由前端消费（`selectors` 全局合并 + `showCustom` 默认开，关闭回退 remote 本体；`AppSummary` / `AppDetail` 包含可选 `source` / `status` / `is_cataloged` 字段，后端投影直接盖章，前端优先读取字段并在乐观本地行缺席时按兜底规则补齐）。
- 前端草稿形状唯一来源：领域形状 `DraftItem` / `DraftEntry` 与线格式 `DraftItemWire` / `DraftEntryWire` 定义于 `src/services/custom.ts`，两者转换同样集中在 `src/services/custom.ts`（`entryFromWire` / `itemToWire` / `itemToSummary`）；`PendingDraftItem` / `CustomDraftEntry` 均指向上述类型别名。
- 风险：草稿详情依赖 `get_repo_coordinates` 的 `external_synth` 回退；若远端仓库改名导致旧草稿 id 命中失败，该草稿留在「待收录」面板且不污染合并视图。

## 6. 展示与统计边界

- 挂载同步：`App.tsx` 挂载时拉取本地收录条目，确保首页与分类列表在首屏即可正确渲染本地收录徽标。
- 趋势统计口径：榜单平台分布按可见行统计，涵盖本地收录行；远端已验证行优先展示蓝标，不叠加本地黄标。
- 待收录表单折叠与占位：`supplemental` 分节折叠偏好持久化于 `localStorage`（`pendingPrefs.ts`）；暂存草稿使用 `OpenSource` 占位协议，提交或收录时由校验门禁拦截并引导补齐真实 SPDX 协议。
