# Issue 01: 画像接入已安装、浏览、搜索三类本地信号

Status: resolved
Blocked by: none

## 背景

一期画像只读 `user_repo_signals`、`user_stars`、`user_favorites`、`watched_apps`。`installed_apps`、`view_history`、`search_history` 已在本地库里却没用上，而且已装应用仍会被推荐（ADR-0023 §2.4）。

## 目标

1. `RawAffinitySignals` 增加 `installed: Vec<(String, i64)>`（id + `installed_at`）、`views: Vec<(String, i64)>`（最近 50 条）、`searches: Vec<(String, i64)>`（最近 20 条）；`Database::load_raw_affinity_signals` 一并读出。
2. `time_decay` 改为带半衰期参数（现有调用保持 30 天），新信号按下表接入 `UserAffinityProfile::from_signals`：

| 信号 | 基准权重 | 半衰期 | 计入 `known_ids` |
|---|---|---|---|
| installed | 3.2 × `repo_scale_factor` | 30 天 | 是 |
| views（仅命中目录） | 0.6 | 7 天 | 否 |
| searches | 0.4，只进 `raw_tokens` | 7 天 | — |

3. `UserAffinityProfile` 公开 `signal_count: usize`（沿用 `AffinityAcc.signal_count` 口径，新信号同样计数；searches 每条计 1）。
4. 新增 `UserAffinityProfile::is_installed(id)` 或等价口径（`installed_ids: HashSet<String>`），供组装器排除候选。

## 范围（互斥）

- 允许修改：`src-tauri/src/db/affinity.rs`、`src-tauri/src/db/history.rs`（如需读口）、`src-tauri/src/github/affinity.rs`。
- 禁止触碰：`src-tauri/src/commands/*`、`src/*`。

## 验收标准

- [ ] 单测：只有 installed 信号时 `has_signals = true`，对应分类权重 > 0，且该 id 在 `known_ids` 与 `installed_ids` 中。
- [ ] 单测：7 天前的浏览权重约为当天的一半（±1%）。
- [ ] 单测：搜索词只影响 `token_weights`，不改 `category_weights`。
- [ ] 现有 `affinity` 与 `catalog_feed_score` 单测不改断言全部通过。
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。
