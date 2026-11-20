# Issue 02: 后端相似开源项目计算引擎与 `get_similar_apps` IPC 命令

Status: resolved
Blocked by: 01

## Summary

基于 `CatalogStore::derived()` 预计算的 `CatalogIdf`、别名表与 `affinity::seed_similarity_with_idf` 算法，新增零网络开销的相似应用计算引擎及 `get_similar_apps` Tauri IPC 命令，支持已收录应用和未收录仓库（在线搜索/开源广场）两种入口，返回带可解释推荐理由与商业平替列表的结构化结果。

## Scope

- Allowed to modify:
  - `src-tauri/src/github/affinity.rs`（提取或复用无状态可解释相似理由生成函数）
  - `src-tauri/src/github/catalog_service.rs`（在 `CatalogService` 新增 `find_similar_apps` 方法，读锁内复用 `store.derived()`）
  - `src-tauri/src/commands/catalog_detail.rs`（新增 `get_similar_apps` 命令及出站结构体 `SimilarAppItem`、`SimilarAppsResponse`）
  - `src-tauri/src/commands/mod.rs`（确认重导出）
  - `src-tauri/src/lib.rs`（在 `tauri::generate_handler!` 注册 `commands::get_similar_apps`）
- Do not modify:
  - `src/` 前端视图与弹窗（在 Issue 03 处理；注：`cmdAlignment.test.ts` 要求 `CMD` 与 `lib.rs` 对齐，实施时可在 Issue 03 合入前端 `CMD` 注册或在本 Issue 先完成后端模块测试）

## Implementation Details

1. **定义出站契约（`commands/catalog_detail.rs`）**：
   - `SimilarAppItem`：
     - `app: AppSummary`
     - `similarity: f64`
     - `reasons: Vec<crate::github::affinity::Reason>`
     - `alternatives: Vec<String>`（`#[serde(default, skip_serializing_if = "Vec::is_empty")]`）
   - `SimilarAppsResponse`：
     - `target_id: String`
     - `target_alternatives: Vec<String>`（`#[serde(default, skip_serializing_if = "Vec::is_empty")]`）
     - `items: Vec<SimilarAppItem>`
2. **命令参数与 `camelCase` 桥接**：
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
   ) -> crate::AppResult<SimilarAppsResponse>
   ```
3. **相似推荐计算逻辑（`CatalogService::find_similar_apps`）**：
   - 入站 `app_id` 经 `crate::commands::require_app_id(&app_id)` 归一化为 `clean_id`；
   - 在 `self.read_store()` 读锁内取得 `derived = store.derived()`：
     - 若 `store.get(&clean_id)` 命中 `CatalogItem`，以 `Self::project_merged_summary` 作为 `seed_summary`，取 `target_alternatives = resolved_alternatives(&item.alternatives, &item.id)`；
     - 否则基于 `clean_id` 解析 `owner/repo`，并用传入的可选字段构造临时 `AppSummary`（`target_alternatives = resolved_alternatives(&[], &clean_id)`）；
   - 读取 `db.get_all_rules()` 构造 `hidden_ids: HashSet<String>`（`r.is_hidden == true`）；
   - 提取 `seed_tokens = affinity_text::extract_summary_tokens(&seed_summary, seed_aliases)`；
   - 遍历 `store.merged()`（远端 + 本地收录 overlay）：
     - 跳过 `item.id.eq_ignore_ascii_case(&clean_id)` 与 `hidden_ids.contains(&item.id.to_lowercase())`；
     - 投影 `cand_summary` 并计算 `sim = seed_similarity_with_idf(&seed_summary, &cand_summary, Some(&derived.idf), Some(&derived.aliases))`；
     - 仅保留 `sim >= 0.25` 的条目；
     - 综合分：`rank = sim * 10.0 + 0.15 * feed_stars_forks_base(item.stars, item.forks)`，降序取前 `limit.unwrap_or(4).clamp(1, 8)` 条；
   - 为每条命中生成可解释 `reasons`（优先 `Reason::Owner`，其次基于 `derived.idf` 的共享高权重 `Reason::Keywords`（最多 3 个词元），兜底 `Reason::Category`）；
   - 从 `db` 批量调用确认图标解析逻辑回填 `app.core.icon`（零网络写透本地已确认图标）。

## Acceptance Criteria

- [ ] Rust 单测覆盖以下场景：
  - 对已收录应用调用 `find_similar_apps`，不返回自身、不返回被 `is_hidden` 隐藏的应用；
  - 对未收录外部应用传入 `name` / `category` / `description`，能正确匹配同赛道已收录应用并输出 `Reason::Keywords` 或 `Reason::Category`；
  - `limit` 越界（如 `0` 或 `100`）被安全夹紧在 `1..=8`；
  - `target_alternatives` 正确反映目标应用的商业软件平替标签。
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全部通过。
