use crate::AppState;
use tauri::State;

/// 趋势榜缓存条目（纯透存：`payload_json` 原样往返，`cached_at` 为落库秒级时间戳，后端不判 TTL）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrendBoardCacheEntry {
    pub payload_json: String,
    pub cached_at: i64,
}

/// 获取趋势榜缓存（薄透传：双命名兼容 `cache_key`/`cacheKey`，仅 trim+空拒绝，不做大小写归一）。
#[allow(non_snake_case)]
#[tauri::command]
pub fn get_trend_board_cache(
    state: State<'_, AppState>,
    cache_key: Option<String>,
    cacheKey: Option<String>,
) -> crate::AppResult<Option<TrendBoardCacheEntry>> {
    let key = cacheKey.or(cache_key).unwrap_or_default();
    let db = state.db()?;
    Ok(db
        .get_trend_board_cache(&key)?
        .map(|(payload_json, cached_at)| TrendBoardCacheEntry {
            payload_json,
            cached_at,
        }))
}

/// 保存趋势榜缓存（薄透传：双命名兼容 `cache_key`/`cacheKey`、`payload_json`/`payloadJson`）。
#[allow(non_snake_case)]
#[tauri::command]
pub fn save_trend_board_cache(
    state: State<'_, AppState>,
    board: String,
    cache_key: Option<String>,
    cacheKey: Option<String>,
    payload_json: Option<String>,
    payloadJson: Option<String>,
) -> crate::AppResult<()> {
    let key = cacheKey.or(cache_key).unwrap_or_default();
    let payload = payloadJson.or(payload_json).unwrap_or_default();
    let db = state.db()?;
    Ok(db.save_trend_board_cache(&key, &board, &payload)?)
}
