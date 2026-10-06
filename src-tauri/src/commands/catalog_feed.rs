use crate::models::AppSummary;
use crate::AppState;
use tauri::State;

/// 发现页卡片摘要（复用 `AppSummary` 形状，前端按 `AppSummary` 解析）。
pub type CatalogItemSummary = AppSummary;

/// 发现页分页载荷（serde 默认 snake_case，前端按 `{ limit, offset, seed }` invoke('get_home_feed')）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct FeedPage {
    pub items: Vec<CatalogItemSummary>,
    pub total: usize,
    pub has_more: bool,
}

/// 发现页 Feed（分页 + 混排）：
/// - `total`=过滤后总量，`has_more`=(offset+limit)<total（saturating，边界守好）；
/// - `seed`=None 时纯 stars 降序（确定性），Some(seed)+balanced 时轻扰动打散头部垄断；
/// - `strategy`=None/非法时回退 balanced（大小写不敏感，前端原样透传、后端归一小写）；
/// - hero 置顶留给前端，后端不 hardcode 具体 id；
/// - 前端按 `invoke('get_home_feed', { limit, offset, seed, strategy })` 调用
///  （`seed`/`strategy` 可省略/传 null）。
#[tauri::command]
pub fn get_home_feed(
    state: State<'_, AppState>,
    limit: usize,
    offset: usize,
    seed: Option<u64>,
    strategy: Option<String>,
) -> Result<FeedPage, String> {
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(&state);
    let all = state.catalog.get_all_summaries();
    let filtered: Vec<AppSummary> = if hidden_ids.is_empty() {
        all
    } else {
        all.into_iter()
            .filter(|a| !hidden_ids.contains(&a.id))
            .collect()
    };
    let ranked = {
        let normalized = strategy.as_deref().unwrap_or("balanced").trim().to_lowercase();
        let parsed = match normalized.as_str() {
            "stars" => crate::github::catalog::FeedStrategy::StarsOnly,
            "fresh" => crate::github::catalog::FeedStrategy::FreshFirst,
            "balanced" => crate::github::catalog::FeedStrategy::Balanced,
            _ => crate::github::catalog::FeedStrategy::Balanced,
        };
        crate::github::catalog::rank_feed_with_strategy(filtered, seed, parsed)
    };
    let (items, total, has_more) = crate::github::catalog::paginate_feed(&ranked, limit, offset);
    Ok(FeedPage {
        items,
        total,
        has_more,
    })
}

#[tauri::command]
pub fn get_category_apps(
    state: State<'_, AppState>,
    category: String,
) -> crate::AppResult<Vec<AppSummary>> {
    let cat_clean = category.trim().to_lowercase();
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(&state);

    let all = state.catalog.get_all_summaries();
    let filtered: Vec<AppSummary> = all
        .into_iter()
        .filter(|a| {
            (a.category.to_lowercase() == cat_clean || a.category_name.to_lowercase() == cat_clean)
                && !hidden_ids.contains(&a.id)
        })
        .collect();

    Ok(filtered)
}
