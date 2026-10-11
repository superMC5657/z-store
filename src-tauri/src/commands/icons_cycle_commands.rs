use super::icons_cycle_probe::{
    KNOWN_ICON_EXTS, download_via_mirror, empty_cycle_result, ensure_cycle_levels,
    first_available_level, is_fallback_for_level, load_split_cached_bytes, next_cycle_level,
    persist_icon_bytes, read_level_cache_file, read_valid_image_file_async, resolve_app_coord,
    source_for_level, IconCycleResult,
};
use crate::AppState;
use tauri::State;

// C1 薄适配器：L1–L5 UI 轮换仅非收录应用可切（收录恒 L1，不切换）；
// 探测经 `ensure_cycle_levels`（L2/L3-live 走 `icon_fetch` 深核，L4 走 `probe_readme`，
// L1 仅收录官方填充），持久化经单一写入路径 `persist_icon_bytes`
//（`catalog vs cycle` 文件名分流收敛在内），下载经 `download_via_mirror`
//（ADR-0002：mirror 只改下载 URL），L5 空选经 `seal_empty_selection` +
// `empty_cycle_result`，detail 同步内联（`data:` 永不进盘，`""` 显式清空）。
// 本文件不写第二套探/第二套文件名规则，只做编排。

/// 循环切换应用图标 (L1..=L5)
#[tauri::command]
pub async fn cycle_app_icon(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();
    if is_cataloged {
        // 加固：收录应用直接返回当前 L1，不切换（防误调）
        return get_app_icon_cycle(state, app_id).await;
    }
    let token = crate::commands::resolve_active_github_token(&state);

    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    let mut cycle = match existing {
        Some(mut c) => {
            ensure_cycle_levels(
                &mut c,
                &state,
                &owner,
                &repo,
                &canonical_id,
                is_cataloged,
                catalog_item.as_ref(),
                token.as_deref(),
            )
            .await;
            if !is_cataloged && c.level == 1 {
                c.level = first_available_level(&c).unwrap_or(2);
            }
            c
        }
        None => {
            let mut c = crate::db::AppIconCycle::new(&canonical_id, &owner, &repo);
            c.is_cataloged = is_cataloged;
            ensure_cycle_levels(
                &mut c,
                &state,
                &owner,
                &repo,
                &canonical_id,
                is_cataloged,
                catalog_item.as_ref(),
                token.as_deref(),
            )
            .await;
            c.level = if is_cataloged {
                1
            } else {
                first_available_level(&c).unwrap_or(2)
            };
            c
        }
    };

    // 计算下一个推进级别
    let next_level = next_cycle_level(cycle.level, &cycle);

    // Level 5: 空（始终可用，直接置空，无需下载；L5 "" 收敛在缝内）
    if next_level == 5 {
        crate::db::icon_cycle::seal_empty_selection(&mut cycle);
        if let Ok(db) = state.db() {
            let _ = db.upsert_icon_cycle(&cycle);
            // 写侧同步内联（原 sync_detail_icon_best_effort）：L5 显式清空 ""，有行才 UPDATE。
            let _ = db.sync_detail_icon(&canonical_id, "");
        }

        return Ok(empty_cycle_result(false));
    }

    // Level 1..=4: 必须下载成功方可推进 level（下载失败不推进 level）
    let target_url = cycle
        .url_for_level(next_level)
        .unwrap_or("")
        .trim()
        .to_string();
    if target_url.is_empty() {
        return Err("目标级别无有效图标链接".into());
    }

    let stem = crate::commands::icons::get_icon_stem(&canonical_id, &target_url);
    let client = crate::commands::icons::icon_http_client();

    // 检查本地是否已存在缓存文件（收录走两表分流读取；非收录按 stem_l{level}.{ext} 匹配）
    let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&target_url).unwrap_or("png");
    let mut cached_bytes = if !is_cataloged {
        read_level_cache_file(&icons_dir, &stem, next_level, inferred_ext)
    } else {
        None
    };
    if cached_bytes.is_none() {
        if let Ok(db) = state.db() {
            if is_cataloged {
                cached_bytes =
                    load_split_cached_bytes(&icons_dir, &db, &stem, inferred_ext, &target_url, true, None);
            }
        }
    }

    let bytes = match cached_bytes {
        Some(b) => b,
        None => {
            // 从远端下载（mirror 只改下载 URL，经单一落点）；若失败，不推进 level，直接返回 Err
            match download_via_mirror(&state, &client, &target_url).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(
                        "cycle_app_icon download failed id={} level={} target_url='{}' err={}",
                        canonical_id,
                        next_level,
                        crate::log_support::sanitize_url(&target_url),
                        e
                    );
                    return Err(e.into());
                }
            }
        }
    };

    // 单一写入路径（catalog vs cycle 文件名分流收敛在缝内，不在命令层双分支）。
    let db_opt = state.db().ok();
    let final_filename = persist_icon_bytes(
        &icons_dir,
        db_opt.as_deref(),
        &stem,
        next_level,
        is_cataloged,
        &target_url,
        &bytes,
    );

    crate::db::icon_cycle::seal_cycle_selection(&mut cycle, next_level, &target_url, final_filename);
    if let Some(db) = db_opt.as_ref() {
        let _ = db.upsert_icon_cycle(&cycle);
        // 写侧同步内联（原 thin helper）：`data:` 永不进盘，有行才 UPDATE，cached_at 不动。
        let sel = cycle.selected_url.trim();
        if !sel.starts_with("data:") {
            let _ = db.sync_detail_icon(&canonical_id, sel);
        }
    }

    let data_uri = crate::commands::icons::bytes_to_data_uri(&bytes);
    Ok(IconCycleResult {
        url: data_uri,
        remote_url: target_url,
        level: next_level,
        source: source_for_level(next_level).to_string(),
        is_fallback: is_fallback_for_level(next_level),
        total_levels: 5,
        is_cataloged: false,
    })
}

/// 只读恢复应用当前图标状态
#[tauri::command]
pub async fn get_app_icon_cycle(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();

    let icons_dir = crate::get_app_data_dir().join("icons");

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    if let Some(cycle) = existing {
        if cycle.level == 5 {
            return Ok(empty_cycle_result(is_cataloged));
        }

        let lvl = if !cycle.is_cataloged && cycle.level == 1 {
            first_available_level(&cycle).unwrap_or(2)
        } else {
            cycle.level
        };
        let remote_url = cycle
            .url_for_level(lvl)
            .filter(|u| !u.trim().is_empty())
            .unwrap_or(&cycle.selected_url)
            .to_string();

        if !cycle.cache_file.is_empty() {
            // 最高频读：经 spawn_blocking 卸载，避免阻塞 async 运行时。
            if let Some(bytes) =
                read_valid_image_file_async(icons_dir.join(&cycle.cache_file)).await
            {
                return Ok(IconCycleResult {
                    url: crate::commands::icons::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged,
                });
            }
        }

        // 文件缺失但有 remote_url 时尝试恢复（单一写入 + 单一下载落点）
        if !remote_url.is_empty() {
            let client = crate::commands::icons::icon_http_client();
            if let Ok(bytes) = download_via_mirror(&state, &client, &remote_url).await {
                let stem = crate::commands::icons::get_icon_stem(&canonical_id, &remote_url);
                // 真实 ext 落盘，绝不产生无扩展名文件（分流收敛在缝内）。
                let filename = persist_icon_bytes(
                    &icons_dir,
                    state.db().ok().as_deref(),
                    &stem,
                    lvl,
                    is_cataloged,
                    &remote_url,
                    &bytes,
                );

                if let Ok(db) = state.db() {
                    let _ = db.set_icon_cycle_selected(&canonical_id, lvl, &remote_url, &filename);
                }

                return Ok(IconCycleResult {
                    url: crate::commands::icons::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged,
                });
            }
        }

        return Ok(IconCycleResult {
            url: String::new(),
            remote_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged,
        });
    }

    // 尚未记录过轮换状态：
    if is_cataloged {
        let default_url = catalog_item
            .as_ref()
            .map(|i| i.icon.trim().to_string())
            .unwrap_or_default();

        if !default_url.is_empty() {
            let stem = crate::commands::icons::get_icon_stem(&canonical_id, &default_url);
            let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&default_url).unwrap_or("png");
            let filename = crate::db::icon_cycle::catalog_filename(&stem, inferred_ext);
            // 最高频读其二：首屏收录图标恢复路径，同样经 spawn_blocking 卸载；其余同步读不动。
            // 无后缀兜底：inferred miss 时遍历其余后缀变体，避免误判无缓存。
            let mut hit_bytes =
                read_valid_image_file_async(icons_dir.join(&filename)).await;
            if hit_bytes.is_none() {
                for ext in KNOWN_ICON_EXTS {
                    if *ext == inferred_ext {
                        continue;
                    }
                    let alt =
                        crate::db::icon_cycle::catalog_filename(&stem, ext);
                    if let Some(b) =
                        read_valid_image_file_async(icons_dir.join(&alt)).await
                    {
                        hit_bytes = Some(b);
                        break;
                    }
                }
            }
            if let Some(bytes) = hit_bytes {
                return Ok(IconCycleResult {
                    url: crate::commands::icons::bytes_to_data_uri(&bytes),
                    remote_url: default_url,
                    level: 1,
                    source: "official".to_string(),
                    is_fallback: false,
                    total_levels: 5,
                    is_cataloged: true,
                });
            }
        }

        // 初始状态且无本地缓存：返回 Level 1 与对应 remote_url
        let lvl = if default_url.is_empty() { 5 } else { 1 };
        return Ok(IconCycleResult {
            url: String::new(),
            remote_url: default_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged: true,
        });
    }

    // 未收录应用且未落库：调 ensure 后返回首个有效级别，无有效则走 L5 首字母徽章逻辑
    let token = crate::commands::resolve_active_github_token(&state);
    let mut temp_cycle = crate::db::AppIconCycle::new(&canonical_id, &owner, &repo);
    temp_cycle.is_cataloged = false;
    ensure_cycle_levels(
        &mut temp_cycle,
        &state,
        &owner,
        &repo,
        &canonical_id,
        false,
        None,
        token.as_deref(),
    )
    .await;

    if let Some(lvl) = first_available_level(&temp_cycle) {
        let remote_url = temp_cycle.url_for_level(lvl).unwrap_or("").trim().to_string();
        let stem = crate::commands::icons::get_icon_stem(&canonical_id, &remote_url);
        let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
        if let Some(bytes) = read_level_cache_file(&icons_dir, &stem, lvl, inferred_ext) {
            return Ok(IconCycleResult {
                url: crate::commands::icons::bytes_to_data_uri(&bytes),
                remote_url,
                level: lvl,
                source: source_for_level(lvl).to_string(),
                is_fallback: is_fallback_for_level(lvl),
                total_levels: 5,
                is_cataloged: false,
            });
        }

        // 文件缺失但有 remote_url 时尝试恢复（单一写入 + 单一下载落点）
        if !remote_url.is_empty() {
            let client = crate::commands::icons::icon_http_client();
            if let Ok(bytes) = download_via_mirror(&state, &client, &remote_url).await {
                let stem = crate::commands::icons::get_icon_stem(&canonical_id, &remote_url);
                let fn_non = persist_icon_bytes(
                    &icons_dir,
                    state.db().ok().as_deref(),
                    &stem,
                    lvl,
                    false,
                    &remote_url,
                    &bytes,
                );
                crate::db::icon_cycle::seal_cycle_selection(
                    &mut temp_cycle,
                    lvl,
                    &remote_url,
                    fn_non.clone(),
                );
                if let Ok(db) = state.db() {
                    let _ = db.upsert_icon_cycle(&temp_cycle);
                }

                return Ok(IconCycleResult {
                    url: crate::commands::icons::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged: false,
                });
            }
        }

        Ok(IconCycleResult {
            url: String::new(),
            remote_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged: false,
        })
    } else {
        // 无有效则走 L5 首字母徽章逻辑（空态统一构造）
        Ok(empty_cycle_result(false))
    }
}
