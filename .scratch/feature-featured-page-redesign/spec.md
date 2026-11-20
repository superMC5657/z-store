# Feature Spec: 精选页重设计（可解释的本地推荐货架）

> 状态：Implemented
> 决策依据：ADR-0023（Accepted）
> 前置：`.scratch/feature-local-affinity-recommendation/`（一期画像已落地）

## 1. 目标

把精选页从「置顶 + 经典推荐 + 全部精选」改为按本地偏好组装的货架页，每个推荐都能说出理由，并支持负反馈与冷启动。全部计算在本机完成，不引入任何服务端。

## 2. 页面结构

自上而下：

1. **画像状态栏**：`根据 N 个本地信号 · 仅在本机计算`（锁图标）+ Top 3 兴趣分类 chip + 偏好入口（跳设置页隐私看板，新增锚点 `#settings-affinity`，导航方式同 `#settings-account`）。`off` 状态改为一条可关闭的开启提示。
2. **今日为你**（`hero`）：1 大 2 小。大卡含图标、名称 · 分类、描述、推荐理由（最多 2 条）、安装 / 打开按钮、「不感兴趣」。
3. **因为你 X 了 Y**（`because_you`）：至多 2 排，每排 4 个，标题按种子关系区分文案（收藏 / 安装 / 关注 / Star / Fork）。
4. **某分类 · 为你挑选**（`category_pick`）：至多 2 排，标题右侧「进入分类」跳分类浏览。
5. **探索新领域**（`explore`）：1 排 4 个，卡片理由为分类名。
6. **本月新入库**（`fresh`）：仅 `off` / `cold`，右侧「查看全部」跳最新入库。
7. **全部精选 · 按你的偏好排序**：`get_home_feed` 分页，滤掉上方已出现的 id；不带理由。
8. **继续查看**：有浏览记录时，在页底显示一条只有图标 + 名称的细条（至多 8 个）。

卡片悬停菜单：「不感兴趣」（scope `app`）、「少推 {分类}」（scope `category`）。点击后卡片就地移除，货架不重排、不补位，直到下次进入页面。页面只在进入、平台筛选结果变化与保存兴趣分类时重新拉取，收藏/安装等画像变化在下次进入页面时体现。

计数展示遵循 `docs/count-display.md`（信号数如作为标签附带数字，用 `<CountBadge>`）。

## 3. 画像状态

| 状态 | 判定 | 区块 |
|---|---|---|
| `off` | `enable_local_affinity = false` | hero（编辑）+ `fresh` + 2 × 日期轮换分类精选（`category_pick`，理由为空）+ 主流 |
| `cold` | 开启，`signal_count = 0` | 兴趣选择卡（占 hero 位）+ 同 `off` 其余区块 |
| `warm` | `1 ≤ signal_count ≤ 4` | hero + 1 × `because_you` + 1 × `category_pick` + `fresh` + 主流 |
| `rich` | `signal_count ≥ 5` | hero + ≤2 × `because_you` + ≤2 × `category_pick` + `explore` + 主流 |

兴趣选择卡：10 个分类 chip 多选，至少选 1 个才可保存；保存后重新拉取页面（此时进入 `warm`）。卡片右上角「跳过」后本次会话不再显示。

## 4. IPC 契约

请求键 camelCase，响应字段 snake_case（见 AGENTS.md）。

```ts
// get_featured_page
args: { daySeed: number; allowedIds?: string[] }  // App 层平台筛选后的可见 id；缺省 = 不限制；无可见应用时前端渲染空态，不发请求
resp: {
  profile_state: 'off' | 'cold' | 'warm' | 'rich';
  signal_count: number;
  top_categories: string[];            // 至多 3 个分类 key
  hero: FeaturedPick[];                // 0–3
  shelves: FeaturedShelf[];
}
FeaturedPick  = { app: AppSummary; reasons: Reason[] }      // reasons ≤ 2
FeaturedShelf = { kind: 'because_you' | 'category_pick' | 'explore' | 'fresh';
                  seed_id?: string; seed_relation?: SeedRelation; category?: string;
                  items: FeaturedPick[] }
Reason = { kind: 'seed'; seed_id: string; relation: SeedRelation }
       | { kind: 'category'; category: string }
       | { kind: 'owner'; owner: string }
       | { kind: 'keywords'; tokens: string[] }   // ≤ 3
       | { kind: 'fresh'; added_at: string }
       | { kind: 'explore'; category: string }
SeedRelation = 'favorite' | 'installed' | 'watched' | 'starred' | 'forked' | 'owned'

// 反馈与兴趣
save_interest_seeds   args: { categories: string[] }            → void（整体替换）
get_interest_seeds    args: {}                                  → string[]
dismiss_featured      args: { target: string; scope: 'app' | 'category' } → void
clear_feed_feedback   args: {}                                  → number（删除行数）

// 既有命令变更
get_home_feed         seed 改为前端传入的 daySeed；被 scope=app 反馈命中的应用沉底
get_affinity_profile_summary  AffinityProfileSummary 补充 installed_count / viewed_count / search_query_count / interest_seeds / feedback_count / signal_count
```

## 5. 数据

```sql
CREATE TABLE IF NOT EXISTS user_interest_seeds (
    category TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_feed_feedback (
    target TEXT NOT NULL,          -- app: canonical id；category: 分类 key
    scope TEXT NOT NULL,           -- 'app' | 'category'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (target, scope)
);
```

两张表都纳入「一键清空本地画像」（`clear_affinity_profile_signals`）。

## 6. 打分与组装要点

- 候选池：`CatalogService::merged_summaries()` → 去掉隐藏规则 → 与 `allowedIds` 求交 → 去掉已安装 → 去掉 90 天内 `app` 反馈。
- 单项得分：`ln(stars+1) + 0.25·ln(forks+1) + affinity_boost + (jitter(daySeed) − 0.5)·0.3`；`off` / `cold` 时 `affinity_boost = 0`。
- `because_you` 相似度（候选 vs 种子）：同分类 0.5 + 同作者 0.3 + 关键词 Jaccard × 0.2，阈值 0.35，再与单项得分按 0.6 : 0.4 混合排序。
- 种子选择：收藏 / 已装 / 关注 / Star / Fork 中按「基准权重 × 时间衰减」取头部，分类互斥，且种子必须命中目录。
- 全页去重（组装）顺序：hero → because_you →（非 rich）fresh → category_pick →（rich）explore；个性化时 category_pick 跳过 because_you 种子已占用的分类。
- 主流打散：`rank_feed_with_profile` 结果做一次贪心重排，同一分类不连续出现超过 2 个（只在前 60 个内生效，保证分页稳定）。

## 7. 不做（后续）

- 曝光疲劳（多次展示未点击的应用逐渐降权）
- 偏好抽屉内手动调整分类权重
- 「本月新入库 · 合你口味」（`fresh` 叠加亲和度阈值）
- 详情页停留时长 / 滚动深度信号

## 8. 验收

- [x] 四种画像状态各有前端单测覆盖区块组合；后端组装器有表驱动单测覆盖去重、分类互斥、平台过滤、已装排除、反馈过期。
- [x] 同一 `daySeed` 下两次调用结果完全一致；换 `daySeed` 后 hero 至少有 1 个变化（目录 ≥ 20 时）。
- [x] `ipcArgsNaming.test.ts`、`noDirectInvoke.test.ts`、`countDisplay.test.ts`、`views.i18n.test.tsx` 通过。
- [x] `pnpm test`、`cargo test --manifest-path src-tauri/Cargo.toml` 全绿；演示站（`vite.demo.config.ts`）精选页可渲染 `rich` 与 `cold` 两种 mock。
