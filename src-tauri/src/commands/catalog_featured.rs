use crate::github::featured::{assemble_featured_page, FeaturedInput, FeaturedPage};
use crate::AppState;
use std::collections::HashSet;
use tauri::State;

/// 精选页整页货架：`day_seed`（`yyyymmdd`）控制当日轮换，可选 `allowed_ids` 按结果求交。
#[tauri::command(rename_all = "camelCase")]
pub fn get_featured_page(
    state: State<'_, AppState>,
    day_seed: u64,
    allowed_ids: Option<Vec<String>>,
) -> crate::AppResult<FeaturedPage> {
    let hidden: HashSet<String> = super::hidden_rule_ids(&state)?
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
