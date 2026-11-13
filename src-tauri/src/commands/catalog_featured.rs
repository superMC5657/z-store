use crate::github::featured::{assemble_featured_page, FeaturedInput, FeaturedPage};
use crate::AppState;
use std::collections::HashSet;
use tauri::State;

/// 精选页整页货架（ADR-0023）。
/// - `day_seed`：前端按本地日期给出的 `yyyymmdd` 整数，当天稳定、隔天轮换；
/// - `allowed_ids`：App 层平台筛选后的可见应用 id；缺省表示不限制。平台筛选口径只在前端
///   `selectPlatformFilteredApps` 一处维护，此处只按结果求交。
#[tauri::command(rename_all = "camelCase")]
pub fn get_featured_page(
    state: State<'_, AppState>,
    day_seed: u64,
    allowed_ids: Option<Vec<String>>,
) -> crate::AppResult<FeaturedPage> {
    let hidden: HashSet<String> = super::catalog_search::hidden_rule_ids(&state)
        .into_iter()
        .map(|id| id.to_lowercase())
        .collect();
    let allowed: Option<HashSet<String>> = allowed_ids.map(|ids| {
        ids.into_iter()
            .map(|id| id.trim().to_lowercase())
            .filter(|id| !id.is_empty())
            .collect()
    });
    let loaded = super::catalog_feed::load_affinity_profile(&state);
    let (enabled, profile) = match &loaded {
        Some((enabled, profile)) => (*enabled, Some(profile)),
        None => (false, None),
    };
    Ok(assemble_featured_page(FeaturedInput {
        all: state.catalog.merged_summaries(),
        allowed_ids: allowed.as_ref(),
        hidden_ids: &hidden,
        profile,
        enabled,
        day_seed,
        now_secs: crate::now_secs(),
    }))
}
