use super::icons_cycle_probe::{
    ensure_cycle_levels, first_available_level, is_fallback_for_level, load_split_cached_bytes,
    mirror_url_for, next_cycle_level, persist_catalog_icon, read_level_cache_file,
    read_valid_image_file_async, resolve_app_coord, source_for_level, IconCycleResult,
};
use crate::AppState;
use tauri::State;

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

    // Level 5: 空（始终可用，直接置空，无需下载）
    if next_level == 5 {
        cycle.level = 5;
        cycle.selected_url = String::new();
        cycle.cache_file = String::new();
        cycle.updated_at = crate::now_secs();
        if let Ok(db) = state.db() {
            let _ = db.upsert_icon_cycle(&cycle);
        }

        return Ok(IconCycleResult {
            url: String::new(),
            remote_url: String::new(),
            level: 5,
            source: "none".to_string(),
            is_fallback: true,
            total_levels: 5,
            is_cataloged: false,
        });
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
    let mirror_url = mirror_url_for(&state, &target_url);

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
            // 从远端下载；若失败，不推进 level，直接返回 Err
            match crate::commands::icons::download_icon_bytes(&client, mirror_url.as_deref(), &target_url).await {
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

    let mime = crate::commands::icons::detect_image_mime(&bytes);
    let real_ext = crate::commands::icons::mime_to_ext(mime);

    // 两表分流持久化（文件名方案收敛至共享 helper；收录分支不可达，已收敛为 canonical 落盘语义）
    let db_opt = state.db().ok();
    let final_filename = if is_cataloged {
        // 收录应用：写 icon_cache_meta，文件名为 stem.ext
        persist_catalog_icon(
            &icons_dir,
            db_opt.as_deref(),
            &stem,
            real_ext,
            inferred_ext,
            &target_url,
            &bytes,
        )
    } else {
        // 非收录应用：只走 app_icon_cycles，文件名为 stem_l{level}.ext 隔离
        let fname = crate::db::icon_cycle::cycle_filename(&stem, next_level, real_ext);
        let fpath = icons_dir.join(&fname);
        let _ = std::fs::write(&fpath, &bytes);
        fname
    };

    crate::db::icon_cycle::seal_cycle_selection(&mut cycle, next_level, &target_url, final_filename);
    if let Some(db) = db_opt.as_ref() {
        let _ = db.upsert_icon_cycle(&cycle);
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
            return Ok(IconCycleResult {
                url: String::new(),
                remote_url: String::new(),
                level: 5,
                source: "none".to_string(),
                is_fallback: true,
                total_levels: 5,
                is_cataloged,
            });
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

        // 文件缺失但有 remote_url 时尝试恢复
        if !remote_url.is_empty() {
            let client = crate::commands::icons::icon_http_client();
            let mirror_url = mirror_url_for(&state, &remote_url);
            if let Ok(bytes) = crate::commands::icons::download_icon_bytes(&client, mirror_url.as_deref(), &remote_url).await {
                let mime = crate::commands::icons::detect_image_mime(&bytes);
                let real_ext = crate::commands::icons::mime_to_ext(mime);
                let stem = crate::commands::icons::get_icon_stem(&canonical_id, &remote_url);
                let filename = if is_cataloged {
                    let fn_cat = crate::db::icon_cycle::catalog_filename(&stem, real_ext);
                    let _ = std::fs::write(icons_dir.join(&fn_cat), &bytes);
                    if let Ok(db) = state.db() {
                        let _ = db.save_icon_cache_url(&fn_cat, &remote_url);
                    }
                    fn_cat
                } else {
                    let fn_non = crate::db::icon_cycle::cycle_filename(&stem, lvl, real_ext);
                    let _ = std::fs::write(icons_dir.join(&fn_non), &bytes);
                    fn_non
                };

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
            if let Some(bytes) = read_valid_image_file_async(icons_dir.join(&filename)).await {
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

        // 文件缺失但有 remote_url 时尝试恢复
        if !remote_url.is_empty() {
            let client = crate::commands::icons::icon_http_client();
            let mirror_url = mirror_url_for(&state, &remote_url);
            if let Ok(bytes) = crate::commands::icons::download_icon_bytes(&client, mirror_url.as_deref(), &remote_url).await {
                let mime = crate::commands::icons::detect_image_mime(&bytes);
                let real_ext = crate::commands::icons::mime_to_ext(mime);
                let fn_non = crate::db::icon_cycle::cycle_filename(&stem, lvl, real_ext);
                let _ = std::fs::write(icons_dir.join(&fn_non), &bytes);
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
        // 无有效则走 L5 首字母徽章逻辑
        Ok(IconCycleResult {
            url: String::new(),
            remote_url: String::new(),
            level: 5,
            source: "none".to_string(),
            is_fallback: true,
            total_levels: 5,
            is_cataloged: false,
        })
    }
}
