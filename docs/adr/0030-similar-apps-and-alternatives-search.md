# ADR-0030：商业软件「开源平替」检索增强与详情页零网络相似开源项目推荐

- 状态：Accepted
- 日期：2026-11-20
- 关联：CONTEXT.md（D1 纯粹开源、D2 零服务器成本、D4 Linear 去彩单色界面）、ADR-0009（独立生态清单仓库）、ADR-0010（规范应用标识）、ADR-0023（可解释本地推荐）、ADR-0024（亲和度词袋 IDF 与种子相似度）
- 落地计划：`.scratch/feature-similar-and-alternatives/`
- 实现：`src-tauri/src/github/alternatives.rs`、`src-tauri/src/github/models.rs`、`src-tauri/src/github/catalog_feed_score.rs`、`src-tauri/src/github/catalog_service.rs`、`src-tauri/src/github/affinity.rs`、`src-tauri/src/commands/catalog_detail.rs`、`src-tauri/src/db/schema.rs`、`src-tauri/src/db/catalog.rs`、`src/components/AppDetailModal/SimilarAppsSection.tsx`、`src/components/AppDetailModal/Header.tsx`、`src/views/SearchResultsView.tsx`、`src/demo/alternatives.ts`

## 1. 背景

用户在使用 ZStore 挑选开源软件时，存在两类高频决策需求：

1. **以商业/闭源软件名检索开源平替**：用户常搜索 `TeamViewer`、`Notion`、`Postman`、`Navicat`、`IDM`、`PotPlayer` 等闭源软件名称寻找可替代的开源软件；仅靠仓库名、别名或简介模糊命中率不全，且用户难以直观理解搜索结果为何命中。
2. **详情页横向对比同赛道开源项目**：查看某款应用（已收录精选条目或在线搜索/开源广场发现的未收录仓库）详情时，缺乏就近的同赛道相似项目对比入口。

## 2. 决策

### 2.1 D1 纯粹开源边界与商业平替元数据隔离

- `CatalogItem.alternatives` 与客户端内置静态映射 `src-tauri/src/github/alternatives.rs`（`builtin_alternatives_for`）中的商业/闭源软件名称**仅作为搜索关键词与可解释平替提示标签**附着在已通过 D1 门禁的开源应用元数据上。
- **绝不**将商业闭源软件作为可安装条目写入 `catalog_apps`、`custom_apps`、精选货架或相似推荐结果。
- 为向后兼容独立生态仓 `z-store-catalog` 的 `catalog.json` 结构：`CatalogItem.alternatives` 与 `AppCore.alternatives` 均声明 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`，`catalog_apps` 通过幂等补列 `alternatives_json` 持久化远端补充的字段；客户端通过 `resolved_alternatives` 将上游清单与内置映射按大小写不敏感去重并集生效。

### 2.2 本地检索分层权重

- `CatalogService::search_local_catalog` 保持分类精确命中（返回全分类按星数降序）不变，关键词打分扩展为：`Exact(100) > Prefix(60) > NameContains(40) > AlternativeMatch(38) > AliasContains(35) > OwnerOrRepoContains(30) > DescriptionContains(20)`。
- 简介模糊检索仅在 `q.chars().count() >= 2` 时启用，避免单字符查询触发大量误召回；搜索卡片仅在查询词命中 `alternatives` 且未命中应用自身名称时展示单色 `.status-tag` 提示。

### 2.3 详情页零网络相似推荐（SSOT）

- 新增同步 IPC 命令 `get_similar_apps`（`camelCase` 入参、`snake_case` 出参），复用读锁内 `CatalogStore::derived()` 预计算的 `CatalogIdf`、别名表与 `affinity::seed_similarity_with_idf`（`0.25 * 同分类 + 0.25 * 同作者 + 0.50 * IDF 加权词元余弦`），前端不再维护第二套相似度打分器。
- 支持已收录应用（直取目录条目与 `resolved_alternatives`）与未收录外部应用（根据入参 `name` / `owner` / `category` / `description` / `descriptionEn` 合成临时 `AppSummary` 种子）；过滤自身及 `update_rules.is_hidden == true` 隐藏条目，保留相似度 `>= 0.25` 的候选并按 `sim * 10 + 0.15 * feed_stars_forks_base` 降序取前 `limit.clamp(1, 8)`（默认 4）条。
- 每条结果附带同源生成的无状态可解释理由（`Reason::Owner` / 高 IDF 共享 `Reason::Keywords` / `Reason::Category`）并叠加本地确认图标；前端 `<SimilarAppsSection>` 在结果为空时静默折叠，点击卡片可在详情弹窗内原地切换并重置滚动位置。

## 3. 后果

- 零服务器、零额外网络请求即可支持常见商业软件平替检索与详情页相似项目对比，符合 D1 / D2 / D4 核心契约。
- 未来若在 `z-store-catalog` 逐条补充 `alternatives` 字段，客户端无需升级即可自动去重并集生效。
