# Feature Spec: 商业软件「开源平替」搜索增强与详情页「相似开源项目」推荐

> 状态：Implemented
> 关联契约：`CONTEXT.md`（D1 纯粹开源、D2 零服务器成本、D4 Linear 去彩单色界面）、`docs/count-display.md`（数量显示规范）、ADR-0010（规范应用标识）、ADR-0023（可解释本地推荐）、ADR-0024（亲和度词袋 IDF 与种子相似度）、ADR-0030（商业软件开源平替与相似项目推荐）。

---

## 1. 核心目标与定位

本特性聚焦「帮用户更快挑对开源软件」两个高频场景，全部在客户端本地零网络开销完成：

1. **商业软件「开源平替」检索与可解释标识**：
   - 解决用户按常见商业/闭源软件名（如 `Notion`、`TeamViewer`、`ToDesk`、`向日葵`、`Postman`、`Photoshop`、`Premiere`、`剪映`、`1Password`、`IDM`、`Xshell`、`Navicat`、`Everything`、`Raycast`、`Typora`、`WinRAR`、`PotPlayer` 等）搜索开源平替时，仅靠仓名/别名命中率不全、简介写了平替词却无法命中搜索的问题；
   - 在详情页元信息行以克制的单色 `.status-tag` 透出「可替代 X」提示，增强用户决策确定性。
2. **详情页底部「相似开源项目」推荐栏**：
   - 复用 `CatalogStore::derived()` 已预计算的 `CatalogIdf`、别名表与 `affinity::seed_similarity_with_idf` 算法，在 `<AppDetailModal>` 底部（`<ReadmeSection>` 下方）零网络实时计算并展示最多 `4` 款同赛道/相似开源软件及可解释推荐理由（同作者 / 共享高 IDF 词元 / 同分类），点击卡片可在详情弹窗内原地跳转对比。

---

## 2. 架构边界与不变量

1. **严格守住 D1 纯粹开源边界**：
   - `alternatives` 与内置商业平替映射表仅作为**搜索关键词与平替标签元数据**附着在已通过 D1 门禁的开源 `CatalogItem` 上，**绝不**将商业闭源软件作为可安装条目写入 `catalog_apps`、`custom_apps` 或推荐货架。
2. **向后兼容 `z-store-catalog` 清单结构**：
   - `CatalogItem.alternatives` 为可选数组（`#[serde(default, skip_serializing_if = "Vec::is_empty")]`），未升级 `catalog.json` 字段时，客户端通过内置 `src-tauri/src/github/alternatives.rs` 静态映射表无缝补齐主流商业平替词；上游清单逐条补充 `alternatives` 后自动与内置映射去重并集生效。
3. **单一真相源（SSOT）**：
   - 相似度公式严格复用 `crate::github::affinity::seed_similarity_with_idf`（`0.25 * 同分类 + 0.25 * 同作者 + 0.50 * IDF 加权词元余弦`），不在前端另写相似度打分器。
   - 隐藏规则统一尊重新鲜状态：被 `update_rules.is_hidden` 隐藏的应用不进入相似推荐输出。
4. **D4 单色视觉与计数规范**：
   - 详情页「相似开源项目」标题数量使用 `<CountBadge value={items.length} />`，禁止硬编码 `相似项目 (4)` 字符串。
   - 推荐理由标签与商业平替标签统一复用 `.status-tag` / `.modal-tag` 单色体系。

---

## 3. 后端设计（`src-tauri/src/`）

### 3.1 `CatalogItem.alternatives` 与内置平替映射表（`src-tauri/src/github/alternatives.rs`）

1. **`CatalogItem` 模型扩展（`src-tauri/src/github/models.rs`）**：
   - 新增字段：
     ```rust
     #[serde(default, skip_serializing_if = "Vec::is_empty")]
     pub alternatives: Vec<String>,
     ```
   - 同步在 `CatalogItem::to_summary()`、`AppCore`（`src-tauri/src/models.rs`）与前端 `AppSummary` / `AppDetail`（`src/types/index.ts`）按需透出（或在 `search_apps` / `get_similar_apps` 中透出 `alternatives: Vec<String>`，避免无谓膨胀序列化体积时采用 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`）。
2. **内置平替映射字典（`src-tauri/src/github/alternatives.rs`）**：
   - 维护静态映射函数 `builtin_alternatives_for(canonical_id: &str) -> &'static [&'static str]`，覆盖高频闭源桌面工具（涵盖远控、笔记、API 调试、密码管理、下载器、终端、数据库客户端、压缩、音视频剪辑、图像编辑、录屏、本地检索、Markdown 等典型赛道）；
   - 提供统一合并函数 `resolved_alternatives(item: &CatalogItem) -> Vec<String>`：先取 `item.alternatives`，再按大小写不敏感去重叠加 `builtin_alternatives_for(&item.id)`。

### 3.2 `search_score` 匹配层级扩展（`src-tauri/src/github/catalog_service.rs` & `catalog_feed_score.rs`）

在 `catalog_feed_score.rs` 新增分数常量，并调整 `search_score` 判定顺序（命中即返回最高优先级档位）：

| 常量 | 分值 | 命中规则 |
|---|---:|---|
| `SEARCH_SCORE_EXACT_MATCH` | 100 | `name` 或 `id` 精确相等 |
| `SEARCH_SCORE_PREFIX_MATCH` | 60 | `name` 前缀命中 |
| `SEARCH_SCORE_NAME_CONTAINS` | 40 | `name` 子串命中 |
| `SEARCH_SCORE_ALTERNATIVE_MATCH` | 38 | `resolved_alternatives(item)` 中任一项大小写不敏感子串命中（如搜 `TeamViewer`、`Notion`、`向日葵`） |
| `SEARCH_SCORE_ALIAS_CONTAINS` | 35 | `item.aliases` 子串命中 |
| `SEARCH_SCORE_OWNER_OR_REPO_CONTAINS` | 30 | `owner` 或 `repo` 子串命中 |
| `SEARCH_SCORE_DESCRIPTION_CONTAINS` | 20 | `description` 或 `description_en` 命中（`q.chars().count() >= 2` 门控，防止单字母噪点泛滥） |

> 注意：`category_matches` 分支保持原有行为（直接命中分类 ID 或中文分类名时返回全分类按 stars 降序），不破坏既有分类检索契约。

### 3.3 `get_similar_apps` 命令与可解释推荐引擎

1. **命令注册（`src-tauri/src/lib.rs`、`src-tauri/src/commands/catalog_detail.rs`、`src-tauri/src/commands/mod.rs`）**：
   ```rust
   #[tauri::command(rename_all = "camelCase")]
   pub fn get_similar_apps(
       state: State<'_, AppState>,
       app_id: String,
       name: Option<String>,
       owner: Option<String>,
       category: Option<String>,
       description: Option<String>,
       description_en: Option<String>,
       limit: Option<usize>,
   ) -> AppResult<SimilarAppsResponse>
   ```
2. **输出结构体（全字段 `snake_case`）**：
   ```rust
   #[derive(Debug, Clone, serde::Serialize)]
   pub struct SimilarAppItem {
       pub app: AppSummary,
       pub similarity: f64,
       pub reasons: Vec<crate::github::affinity::Reason>,
       #[serde(default, skip_serializing_if = "Vec::is_empty")]
       pub alternatives: Vec<String>,
   }

   #[derive(Debug, Clone, serde::Serialize)]
   pub struct SimilarAppsResponse {
       pub target_id: String,
       #[serde(default, skip_serializing_if = "Vec::is_empty")]
       pub target_alternatives: Vec<String>,
       pub items: Vec<SimilarAppItem>,
   }
   ```
3. **Seed 构造与候选打分流程**：
   - 入站 `app_id` 经 `crate::commands::require_app_id(&app_id)` 校验归一化；
   - 在 `CatalogService` 读锁内获取 `CatalogStore` 与缓存的 `CatalogDerived`（含 `idf` 与 `aliases`）：
     - 若 `store.get(&clean_id)` 命中，直接投影为 `seed_summary` 并取 `target_alternatives = resolved_alternatives(item)`；
     - 若未命中（未收录仓库：在线搜索结果 / 开源广场条目），利用入参 `name` / `owner` / `category` / `description` / `description_en`（缺省从 `clean_id` 拆分 `owner/repo`）构造临时 `AppSummary` 作为 `seed_summary`；
   - 读取 `db.get_all_rules()` 提取 `is_hidden == true` 的小写 ID 集合 `hidden_ids`；
   - 预提取 `seed_tokens`（复用 `affinity_text::extract_summary_tokens`），遍历 `store.merged()` 全量条目：
     - 跳过 `item.id.to_lowercase() == clean_id` 与 `hidden_ids` 命中项；
     - 计算 `sim = seed_similarity_with_idf(&seed_summary, &cand_summary, Some(&derived.idf), Some(&derived.aliases))`；
     - 仅保留 `sim >= 0.25` 的候选；
     - 综合排序分：`rank_score = sim * 10.0 + 0.15 * feed_stars_forks_base(item.stars, item.forks)`（同分按 `stars DESC, id ASC`）；
   - 取前 `limit.unwrap_or(4).clamp(1, 8)` 条，为每条构造可解释 `reasons`（同作者 → `Reason::Owner`；高 IDF 共享词元 → `Reason::Keywords`；同分类 → `Reason::Category`）并叠加本地确认图标（`resolve_confirmed_icon_from_db`）。

---

## 4. 前端设计（`src/`）

### 4.1 API 封装与 Demo Mock 对齐
- `src/services/api.ts`：`CMD` 新增 `getSimilarApps: 'get_similar_apps'`。
- `src/services/api/catalog.ts`：新增 `getSimilarApps(params: GetSimilarAppsParams): Promise<SimilarAppsResponse>`，严格使用 camelCase 参数键（`appId`, `name`, `owner`, `category`, `description`, `descriptionEn`, `limit`）。
- `src/demo/handlers/catalog.ts` & `src/demo/tauri-mock.ts`：实现同构的 `handleGetSimilarApps`，基于 Demo 种子目录与 `alternatives` 静态映射计算相似推荐与平替标签，保证 `ipcArgsNaming.test.ts` 与 `cmdAlignment.test.ts` 全绿。

### 4.2 详情页推荐区块与平替标识
- **新增 `src/components/AppDetailModal/SimilarAppsSection.tsx`**：
  - 在 `AppDetailModal/index.tsx` 中挂载于 `<ReadmeSection>` 下方；
  - 每次 `app.id` 变化（或加载完成拿到最新 `category`/`description`）时请求 `tauriApi.getSimilarApps`，带请求序列防竞态守卫（`reqRef`）；
  - 结果为空时静默折叠不占空位；有结果时展示：
    - 区块标题：`t('detail.similar.title')` + `<CountBadge value={items.length} />`；
    - 4 列（窄屏自适应 2 列）单色紧凑卡片：`<AppIconFrame size="sm">`、应用名、星数、平台图标、以及最多 1 条简洁推荐理由（`.status-tag`，如 `同作者`、`共享关键词: markdown`、`同分类 · 笔记`）；
    - 点击任意卡片触发 `onOpenSimilarApp(item.app.id)`，调用外层 `onOpenDetail(id)` 原地切换弹窗内容，并自动将 `.modal-body` 滚动回到顶部。
- **`AppDetailModal/Header.tsx` 平替标签**：
  - 当 `target_alternatives.length > 0` 时，在 Header 元信息标签区展示单色 `.modal-tag`：`t('detail.alternatives_badge', { targets: targetAlternatives.slice(0, 2).join(' · ') })`（悬浮 `title` 展示完整列表）。
- **`SearchResultsView.tsx` 搜索平替命中提示**：
  - 当本地搜索命中 `AppSummary` 的 `alternatives`（查询词命中其平替对象而非自身名字）时，在搜索卡片尾部或标题副标签轻量透出 `可替代 <命中词>` 单色徽标，让用户一眼看懂为何搜 `TeamViewer` 会出 `RustDesk`。

---

## 5. 测试与验收门槛

1. **Rust 单元测试**：
   - `alternatives.rs` 去重并集、`search_score` 分层排序（搜 `TeamViewer` / `Notion` / `Postman` 命中对应平替应用且严格高于仅简介模糊命中）；
   - `get_similar_apps` 单元测试覆盖：已收录 seed、未收录动态 seed（如只有名称与描述）、排除自身、过滤 `is_hidden` 隐藏项、`reasons` 解释生成、零结果边界。
2. **前端单测与静态门禁**：
   - `SimilarAppsSection` 组件测试（空态折叠、点击卡片切换详情、`<CountBadge>` 规范）；
   - `Header.tsx` 商业平替标签展示测试；
   - `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`countDisplay.test.ts`、`views.i18n.test.tsx` 全绿。
