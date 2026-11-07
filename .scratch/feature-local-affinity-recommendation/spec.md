# Feature Spec: 本地用户画像与 Catalog 动态推荐（Local Affinity Recommendation）

> 状态：Draft（Ready for Implementation · Phase 1 含本地隐私数据看板）
> 架构边界：严格遵循 D2 零服务器成本（Serverless Direct API）与 ADR-0013（发现页 Feed 契约），全链路在客户端本地 Rust + SQLite (`z_store.db`) + React 内闭环完成，不引入任何中心化推荐服务端。

## 1. 目标与一/二期范围边界

当前发现页（`HomeView`）的「经典精选开源软件」与「全部精选开源收录」仅按 `ln(stars + 1) + jitter` 静态星数倒排（见 `src-tauri/src/github/catalog_feed_score.rs` 与 `src/services/feed.ts`），导致头部高星项目长期垄断首屏，无法反映用户的真实技术栈与开源偏好。

### 1.1 一期范围（Phase 1 · 当前实施范围）
在**零服务端资源消耗**的前提下，一期严格聚焦于**显式星标、Fork、关注数据与本地隐私透明可控**：
1. **GitHub 账号 Stars & Forks 画像信号**：用户登录 GitHub 后拉取其 `starred` 仓库（`/user/starred`）与 `forked` / `owned` 仓库（`/user/repos?type=owner`），提取仓库自身的 `stars`、`forks`、`language`、`description` 存入本地 SQLite。
2. **本应用内 Stars / Favorites & Watch 信号**：直接读取本地 SQLite 已有的应用内星标/收藏（`user_stars`、`user_favorites`）与版本关注（`watched_apps`）表。
3. **候选 Catalog 应用自身的 Stars & Forks 双因子质量基线**：结合候选应用自身的 `stars` 与 `forks`（含对数加成与 `forks/stars` 社区活跃比共鸣度）。
4. **跨周期重开增量刷新（解决半个月/数周后再打开的画像保鲜）**：不仅在首次登录时拉取；当用户半个月或任意时间后重新打开应用时，启动流程检查本地 `affinity_github_synced_at` 时间戳，一旦超过冷却窗口（6 小时），即在后台通过 `api_etag_cache`（携带 `If-None-Match` 条件请求，未变更时 `304 Not Modified` 零配额消耗）静默增量同步用户最新的 GitHub Stars 与 Forks。
5. **直接接替默认精选排序**：用本地动态推荐直接替换首页「经典精选开源软件」（前 4 项）与「全部精选开源收录」（主列表）的默认 `balanced` 倒排逻辑；未登录且无星标/关注数据时平滑退化为原有 `balanced` 基线。
6. **本地推荐画像与隐私数据看板（Settings · 数据管理与隐私审计）**：在设置页「数据管理与备份」（`DataManagementSection`）中内嵌**本地推荐与隐私数据看板（`AffinityPrivacyRow`）**，向用户透明展示本地 SQLite 中已采集的信号统计（GitHub Star/Fork 仓库数、应用内收藏/Watch 数、推断出的 Top 偏好分类与语言、最近同步时间），并提供**个性化推荐开关（`enable_local_affinity`）**、**立即增量同步**与**一键清空本地画像数据**能力。

### 1.2 明确不做的事项与二期范围（Out of Scope / Phase 2）
- **不做本地收录搜索缓存**：当前 Catalog 仅约 300 款应用，内存切片与 SQLite 直接扫描已在微秒级完成，无需额外引入本地搜索索引缓存层。
- **二期范围（Phase 2 · 延后规划，一期不做）**：
  - 日常点击与浏览历史（`view_history` / `record_app_view`）加权
  - 搜索关键词历史（`search_history` / `record_search_query`）加权
  - 详情页停留时长（Dwell Time）与滚动深度采集

---

## 2. 核心架构与数据模型（一期）

### 2.1 SQLite 本地信号表 (`user_repo_signals`)

在 `src-tauri/src/db/schema.rs` 的幂等基底 DDL 中新增 `user_repo_signals` 表，持久化用户 GitHub 账号 Star / Fork 仓库的特征属性：

```sql
CREATE TABLE IF NOT EXISTS user_repo_signals (
    full_name TEXT NOT NULL,
    relation TEXT NOT NULL,           -- 'starred' | 'forked' | 'owned'
    language TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    stars INTEGER NOT NULL DEFAULT 0,
    forks INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (full_name, relation)
);

CREATE INDEX IF NOT EXISTS idx_user_repo_signals_updated_at ON user_repo_signals(updated_at);
```

一期本地信号快照 `RawAffinitySignals`（由 `Database::load_raw_affinity_signals` 一次性零网络从 SQLite 读取，**仅读取星标、Fork 与关注相关表**）：
- `favorites`: `user_favorites (app_id, favorited_at)` — 应用内收藏，权重 `4.0`
- `repo_signals (forked)`: `user_repo_signals (relation='forked')` — 用户 GitHub Fork 的仓库，权重 `3.8`
- `watched`: `watched_apps (app_id, added_at)` — 应用内关注（Watch），权重 `3.5`
- `repo_signals (starred)` / `user_stars`: — 用户 GitHub Star / 应用内 Star 的仓库，权重 `3.0`
- `repo_signals (owned)`: `user_repo_signals (relation='owned')` — 用户个人仓库，权重 `2.4`

### 2.2 本地亲和度画像 (`UserAffinityProfile`)

由 `UserAffinityProfile::from_signals(&RawAffinitySignals, &[CatalogItem], now_secs)` 在内存中实时聚合：

1. **时间衰减（Time Decay）**：
   $$\text{decay}(\Delta t) = \max\left(0.25, \exp\left(-\frac{\ln 2}{30 \times 86400} \cdot \max(0, \text{now} - t)\right)\right)$$
2. **信号源仓库 Stars & Forks 规模调制**：
   $$m(r) = 1.0 + 0.04 \ln(\text{stars}_r + 1) + 0.08 \ln(\text{forks}_r + 1)$$
3. **Fork 仓库上游反查与未收录仓库分类推断**：
   - 若用户 Fork 的仓库 `user/repo` 不直接命中 `CatalogItem.id`，按同名 `repo` 反查收录库中的上游官方项 `<upstream>/repo`；
   - 对未收录的 GitHub Star/Fork 仓库，根据其 `language`、`description` 与 `full_name` 经确定性规则表 `infer_categories_from_repo` 映射至 ZStore 的 10 大标准分类（`dev`、`ops`、`media`、`office`、`security`、`graphics`、`network`、`system`、`reading`、`games`）。
4. **饱和归一化（Soft-Saturated Normalization）**：
   对分类权重 `category_weights`、开发者权重 `owner_weights`、词袋权重 `token_weights` 分别按相对比例与置信度饱和函数归一至 $[0.0, 1.0]$：
   $$W(k) = \frac{v_k}{\max_j v_j} \cdot \left(1 - \exp\left(-\frac{v_k}{\tau}\right)\right)$$

### 2.3 动态推荐打分公式 (`rank_feed_with_profile`)

对每个候选应用 $a \in \text{Catalog}$：

$$\text{Score}(a) = \underbrace{\ln(\text{stars}_a + 1) + 0.25 \ln(\text{forks}_a + 1)}_{\text{应用自身 Stars/Forks 基线}} + \underbrace{3.2 P_{\text{cat}}(a) + 1.8 P_{\text{owner}}(a) + 1.8 P_{\text{tok}}(a) + \text{ForkResonance}(a)}_{\text{用户 Stars/Forks/Watch 画像增益}} - \underbrace{1.2 \cdot \mathbb{I}(a \in \text{AlreadyKnown})}_{\text{已收藏/已关注适度让位推新}} + \underbrace{(\text{jitter01} - 0.5) \times 0.3}_{\text{同档确定性轻扰动}}$$

- **无信号冷启动或开关关闭兼容**：当 `profile.has_signals == false` 或用户在隐私看板关闭 `enable_local_affinity` 时，不施加画像增益；当测试固件 `forks == 0` 时，公式严格退化为 `ln(stars + 1) + (jitter01 - 0.5) * 0.3`，既有单元测试 100% 零回归。
- **已 Star/Watch 种子推新**：用户已收藏或已 Watch 的应用作为强正反馈种子提升同分类/同开发者/同技术栈权重，同时对已收藏/已关注条目自身适度减 `1.2` 分，把首页前 4「经典精选」席位优先让给用户尚未发现的同类优质软件。

### 2.4 本地推荐与隐私数据看板 (`AffinityPrivacyRow`)

为体现「零服务器上传、数据主权完全归属用户本地」的设计理念，在设置页 `DataManagementSection.tsx` 中提供可视化审计与控制面板：
- **画像摘要只读视图（`AffinityProfileSummary`）**：
  - `enabled`: 当前是否启用本地个性化精选重排（对应 `user_settings.enable_local_affinity`，默认 `"true"`）
  - `starred_repo_count`: 本地缓存的 GitHub Star 仓库信号数
  - `forked_repo_count`: 本地缓存的 GitHub Fork 仓库信号数
  - `owned_repo_count`: 本地缓存的个人自有仓库信号数
  - `favorites_count` / `watched_count`: 应用内收藏与关注应用数
  - `top_categories`: 当前画像归一化权重最高的 Top 3 分类及百分比（如 `[{ category: "dev", weight: 0.92 }, ...]`）
  - `top_languages`: 信号仓库中最常出现的 Top 3 编程语言（如 `["Rust", "TypeScript", "Go"]`）
  - `last_synced_at`: 最近一次 GitHub 画像增量同步的 Unix 时间戳
- **用户控制动作**：
  - **开关切换**：通过 `save_setting("enable_local_affinity", "true" | "false")` 实时启停个性化推荐并广播 `zstore://affinity-updated`；
  - **立即增量同步**：调用 `sync_github_starred`（内部联动 `sync_github_affinity_signals`）执行 ETag 条件刷新；
  - **一键清空本地画像**：调用 `reset_affinity_profile` 清空 `user_repo_signals` 与 `affinity_github_synced_at`，立即恢复默认无画像基线。

---

## 3. 实施 Issue 拆分清单（一期）

- [`01-sqlite-repo-signals-schema.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/01-sqlite-repo-signals-schema.md)：SQLite `user_repo_signals` 表结构与一期 `RawAffinitySignals`（仅 `user_repo_signals`、`user_stars`、`user_favorites`、`watched_apps`）读写层。
- [`02-github-login-silent-sync.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/02-github-login-silent-sync.md)：GitHub 首次登录同步 + 跨周期启动增量刷新（6h 冷却 + `api_etag_cache` ETag 条件请求）与 `zstore://affinity-updated` 事件广播。
- [`03-affinity-profile-and-scoring-engine.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/03-affinity-profile-and-scoring-engine.md)：Rust 本地画像构建器 `UserAffinityProfile`、10 大分类推断器与 `rank_feed_with_profile` 打分引擎（接入 `get_home_feed`）。
- [`04-home-feed-replacement-and-live-refresh.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/04-home-feed-replacement-and-live-refresh.md)：前端 `useHomeFeed` / `feed.ts` 接替「经典精选」与「全部精选」排序，联动 `zstore://affinity-updated` 实时刷新。
- [`05-affinity-privacy-audit-panel.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/05-affinity-privacy-audit-panel.md)：本地推荐画像与隐私数据看板（后端摘要/重置接口 + 设置页 `AffinityPrivacyRow` 可视化审计、启停开关与一键清空）。
- [`06-docs-adr-and-acceptance.md`](file:///z:/rust_workplace/z-store/.scratch/feature-local-affinity-recommendation/issues/06-docs-adr-and-acceptance.md)：领域词汇表（`CONTEXT.md`）、ADR-0013 更新与全量门禁验收。
