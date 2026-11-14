use crate::AppState;
use tauri::State;

/// 趋势榜缓存条目（纯透存：`payload_json` 原样往返，`cached_at` 为落库秒级时间戳，后端不判 TTL）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrendBoardCacheEntry {
    pub payload_json: String,
    pub cached_at: i64,
}

/// 获取趋势榜缓存：`cache_key` 经 trim，空拒绝；后端不判 TTL，由前端 L2 执行。
#[tauri::command(rename_all = "camelCase")]
pub fn get_trend_board_cache(
    state: State<'_, AppState>,
    cache_key: String,
) -> crate::AppResult<Option<TrendBoardCacheEntry>> {
    let key = cache_key.trim().to_string();
    let db = state.db()?;
    Ok(db
        .get_trend_board_cache(&key)?
        .map(|(payload_json, cached_at)| TrendBoardCacheEntry {
            payload_json,
            cached_at,
        }))
}

/// 保存趋势榜缓存：`cache_key` 与 `payload_json` 经 trim，空拒绝；后端不判 TTL，由前端 L2 执行。
#[tauri::command(rename_all = "camelCase")]
pub fn save_trend_board_cache(
    state: State<'_, AppState>,
    board: String,
    cache_key: String,
    payload_json: String,
) -> crate::AppResult<()> {
    let key = cache_key.trim().to_string();
    let payload = payload_json.trim().to_string();
    let db = state.db()?;
    Ok(db.save_trend_board_cache(&key, &board, &payload)?)
}

/// 读取在线搜索列表快照：`cache_key` 经 trim，空返回 `None`；新鲜度由前端判定。
#[tauri::command(rename_all = "camelCase")]
pub fn get_search_list_cache(
    state: State<'_, AppState>,
    cache_key: String,
) -> crate::AppResult<Option<crate::models::SearchListCacheEntry>> {
    let db = state.db()?;
    Ok(db
        .get_search_list_cache(&cache_key)?
        .map(
            |(payload_json, cached_at, has_private)| crate::models::SearchListCacheEntry {
                payload_json,
                cached_at,
                has_private,
            },
        ))
}

/// 保存在线搜索列表快照（`v: 2` 分页有序 id 索引）：键、查询与载荷经 trim，空串跳过；
/// 单条超过 64 KiB 拒绝；`has_private` 为真时随登出清除。
#[tauri::command(rename_all = "camelCase")]
pub fn save_search_list_cache(
    state: State<'_, AppState>,
    cache_key: String,
    norm_query: String,
    payload_json: String,
    has_private: Option<bool>,
) -> crate::AppResult<()> {
    let db = state.db()?;
    Ok(db.save_search_list_cache(
        &cache_key,
        &norm_query,
        &payload_json,
        has_private.unwrap_or(false),
    )?)
}
