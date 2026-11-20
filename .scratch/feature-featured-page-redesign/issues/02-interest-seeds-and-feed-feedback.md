# Issue 02: 兴趣种子与推荐负反馈（表、读写口、命令、画像消费）

Status: resolved
Blocked by: 01

## 背景

冷启动用户没有任何信号；已有用户无法表达「不要这个 / 少推这类」（ADR-0023 §2.4、§2.5）。

## 目标

1. `schema.rs` 幂等创建 `user_interest_seeds`、`user_feed_feedback`（DDL 见 spec §5）。
2. `db/affinity.rs`：
   - `replace_interest_seeds(&[String])`、`get_interest_seeds()`
   - `upsert_feed_feedback(target, scope, now)`、`get_active_feed_feedback(now)`（只返回 90 天内）、`clear_feed_feedback() -> usize`
   - `clear_affinity_profile_signals` 一并清空两张表。
3. `RawAffinitySignals` 增加 `interest_seeds`、`feedback`；`from_signals`：
   - 每个兴趣种子给 `raw_cat` 加 2.0（不衰减），每个计 1 个信号；
   - 归一化之后，`scope=category` 的分类权重 ×0.5；
   - 公开 `dismissed_app_ids: HashSet<String>`。
4. 命令（`#[tauri::command(rename_all = "camelCase")]`，注册进 `lib.rs`）：`save_interest_seeds { categories }`、`get_interest_seeds`、`dismiss_featured { target, scope }`、`clear_feed_feedback`。`target` 在 scope=app 时经 `canonical_app_id()` 归一；scope 非法返回错误。写入成功后发出现有的画像更新事件（与 `sync_affinity_signals` 完成时同一事件）。
5. `AffinityProfileSummary` 增加 `installed_count`、`viewed_count`、`search_query_count`、`interest_seeds`、`feedback_count`、`signal_count`。

## 范围（互斥）

- 允许修改：`src-tauri/src/db/schema.rs`、`src-tauri/src/db/affinity.rs`、`src-tauri/src/github/affinity.rs`、`src-tauri/src/commands/catalog_feed.rs`、`src-tauri/src/lib.rs`（仅命令注册）。
- 禁止触碰：`src/*`。

## 验收标准

- [x] 存量库经 `init_schema()` 后两张新表存在，迁移测试通过。
- [x] 单测：91 天前的反馈不出现在 `get_active_feed_feedback`。
- [x] 单测：只有兴趣种子时 `signal_count` 等于种子数，`has_signals = true`。
- [x] 单测：`scope=category` 反馈使该分类权重减半。
- [x] 单测：清空本地画像后两张表为空。
