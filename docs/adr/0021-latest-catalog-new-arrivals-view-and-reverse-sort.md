# ADR-0021：最新入库独立视图与收录时间倒排架构规范

- 状态：Accepted
- 日期：2026-10-22
- 关联：ADR-0007（开放清单与 TTL 缓存）、ADR-0009（清单仓库解耦）、ADR-0010（规范应用标识）、ADR-0013（Feed 契约）、ADR-0017（本地自维护草稿 overlay）
- 范围：后端（`CatalogItem` / `AppCore` 扩展 `added_at`、`custom_apps` overlay 投影回填、`get_latest_catalog_apps` IPC 命令与内存倒排）+ 前端（`latest` 独立一级视图、侧栏导航、分段选项卡、触底加载与空态兜底）

## 1. 背景

`catalog.json` 规范中包含每个应用收录进入精选库的日期字段 `added_at`（ISO `YYYY-MM-DD` 格式，全量 362 条存量数据均已具备），但此前未在 Rust 运行时类型 (`CatalogItem` / `AppCore`) 及前端 `AppSummary` 中显式建模；同时此前缺乏按收录时效性探索应用的能力（首页 Feed 仅做 Balanced / StarsOnly 混排，Trends 仅跟踪外部 GitHub 趋势）。

用户需要一个直观的最新入库发现通道，支持“最近一周”、“最近一个月”、“最近一季度”等时效过滤并由近及远倒排展示。

## 2. 决策

### 2.1 独立一级视图与侧栏导航 (`latest`)
1. **视图注册**：在 `src/app/navigation.ts` 中将 `latest` 纳入 `VIEW_TYPES` 契约，排在 `home` 与 `categories` 之间：
   ```ts
   export const VIEW_TYPES = [
     'home',
     'latest',
     'categories',
     'trends',
     'pending',
     'installed',
     'updates',
     'favorites',
     'settings',
   ] as const;
   ```
2. **侧栏归属**：归属 `discovery`（发现）分组，中文名「最新入库」，英文名「New Arrivals」，图标采用 Fluent 单色矢量微图标（`Sparkles` 矢量），遵循 D4 去彩单色设计规范。

### 2.2 预设时间分桶与状态机
1. **分段控制 (Segmented Control)**：提供 3 档时间窗（不设「全部」档，全量浏览交给「分类浏览」与「精选发现」）：
   - `7d`：最近 7 天 (入库距今 ≤ 7 天)
   - `30d`：最近 30 天 (入库距今 ≤ 30 天，**默认激活态**)
   - `90d`：最近 90 天 (入库距今 ≤ 90 天，时效上限)
2. **空态兜底**：当选定时间段暂无新收录时，渲染 `FilterEmptyState`，并提供向更宽档位递进的快速引导：`7d` 给「切换至最近 30 天」+「切换至最近 90 天」，`30d` 给「切换至最近 90 天」，`90d` 已是上限仅提示文案，杜绝死胡同。

### 2.3 倒排与并列保质规则 (Ties Breaking)
1. **一级主序**：`added_at DESC`（严格由近及远）。
2. **二级次序**：`stars DESC`（GitHub Star 数降序）。
   - **决策权衡**：由于存量 `catalog.json` 中存在同一天批量导入百余款应用的情况（如 `2026-09-10` 与 `2026-09-13`），若同天仅按名称字典序排列容易使低质或冷门小工具占据头部；引入 Star 数次级降序可在保证时效倒排的前提下，确保列表呈现的高水准与实用性。

### 2.4 领域模型与本地收录兼顾 (Domain Modeling & Overlay Alignment)
1. **契约扩展**：
   - `CatalogItem` 与 `AppCore` 新增：
     ```rust
     #[serde(default, skip_serializing_if = "Option::is_none")]
     pub added_at: Option<String>,
     ```
   - 前端 `AppSummary` 扩展 `added_at?: string;`。
2. **本地自维护条目兼容**：
   - 本地 `custom_apps` 表存储的是 Unix 整数 `created_at`。
   - 在 `CatalogService::sync_collected_from_db` 与合并视图投影时，将 `created_at` 统一转换为 `YYYY-MM-DD` 格式回填入 `added_at`，确保用户自维护的本地应用无缝参与「最新入库」倒排，遵循 ADR-0017 库内成员同权原则。

### 2.5 IPC 架构与分页性能
1. **命令契约**：
   ```rust
   #[tauri::command(rename_all = "camelCase")]
   pub fn get_latest_catalog_apps(
       state: State<'_, AppState>,
       since_days: Option<u32>,
       page: Option<u32>,
       per_page: Option<u32>,
   ) -> crate::AppResult<FeedPage>
   ```
2. **纯内存零网络执行**：
   - 数据源为 `CatalogService::merged_summaries()`（已合并远端与本地库）；
   - 在内存中执行日期比对截断与 `added_at DESC, stars DESC` 排序；
   - 复用既有 `paginate_feed` 窗口计算逻辑，返回 `FeedPage { items, total, has_more }`，首屏秒开，支持触底无限加载。
