use crate::AppState;
use tauri::State;

/// 趋势榜缓存条目（纯透存：`payload_json` 原样往返，`cached_at` 为落库秒级时间戳，后端不判 TTL）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrendBoardCacheEntry {
    pub payload_json: String,
    pub cached_at: i64,
}

/// 获取趋势榜缓存：`cache_key` 经 trim，空拒绝；后端不判 TTL，由前端 L2 执行。
#[tauri::command]
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
#[tauri::command]
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
