use super::icons_cycle_probe::{
    KNOWN_ICON_EXTS, download_via_mirror, empty_cycle_result, ensure_cycle_levels,
    first_available_level, is_fallback_for_level, load_split_cached_bytes, next_cycle_level,
    persist_icon_bytes, read_level_cache_file, read_valid_image_file_async, resolve_app_coord,
    source_for_level, IconCycleResult, IconRef,
};
use crate::AppState;
use tauri::State;

// C1 薄适配器：L1–L5 UI 轮换仅非收录应用可切（收录恒 L1，不切换）；
// 探测经 `ensure_cycle_levels`（L2/L3-live 走 `icon_fetch` 深核，L4 走 `probe_readme` 头部备选 Logo，
// 正文图永不进链），持久化经单一写入路径 `persist_icon_bytes`（hash 单轨
// `sha256(url)[0:16]+sniff ext`），下载经 `download_via_mirror`
//（ADR-0002：mirror 只改下载 URL），L5 空选经 `seal_empty_selection` +
// `empty_cycle_result`（清选中态 + 删旧文件 + `sync_detail_icon("")` 防诈尸），detail 同步内联
//（`data:` 永不进盘，`""` 显式清空）。
// 手动选择持久化三件套：`selected_url + level + icons 文件` 同 tick 落库（kubenav/GNS3 首次 N=1 之后 N=0）。
// 本文件只做编排，不写探测与文件名规则；图标通道禁用 ETag（命中 0 请求，7 天 TTL）。

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

    // 计算下一个推进级别（非收录跳 L1：next 绝不落 1，见 `next_cycle_level`；收录恒 L1 已早返）
    let next_level = next_cycle_level(cycle.level, &cycle);

    // Level 5: 空（始终可用，直接置空，无需下载；L5 "" 收敛在缝内；清对应旧文件防诈尸）
    if next_level == 5 {
        let old_file = cycle.cache_file.clone();
        crate::db::icon_cycle::seal_empty_selection(&mut cycle);
        if let Ok(db) = state.db() {
            let _ = db.upsert_icon_cycle(&cycle);
            // 写侧同步内联（原 sync_detail_icon_best_effort）：L5 显式清空 ""，有行才 UPDATE。
            let _ = db.sync_detail_icon(&canonical_id, "");
        }
        // L5 清对应文件：旧糊图删盘（DB URL 保留在 l2..l4 备选中供重选，删盘不删 URL）。
        if !old_file.trim().is_empty() {
            let _ = std::fs::remove_file(icons_dir.join(old_file.trim()));
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

    // 手动选择持久化前先固化探测到的备选 URLs（N=1→0：即使本次下载失败，l2..l4 已落库下次 0 探）。
    // best-effort upsert，不阻塞下载（`let _` 吞错，下次重试）。
    if let Ok(db) = state.db() {
        let _ = db.upsert_icon_cycle(&cycle);
    }

    let client = crate::commands::icons::icon_http_client();

    // 检查本地是否已存在缓存文件（hash 候选 + 7 天 TTL，0 请求命中）。
    let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&target_url).unwrap_or("png");
    let icon = IconRef::new(&target_url, inferred_ext);
    let mut cached_bytes = if !is_cataloged {
        read_level_cache_file(&icons_dir, &icon)
    } else {
        None
    };
    if cached_bytes.is_none() {
        if let Ok(db) = state.db() {
            if is_cataloged {
                cached_bytes =
                    load_split_cached_bytes(&icons_dir, &db, &icon, true, None);
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

    // 单一写入路径（FINAL hash 单轨，不在命令层双分支；`data:` 永不进盘由下 sync 守卫）。
    let db_opt = state.db().ok();
    let final_filename = persist_icon_bytes(
        &icons_dir,
        db_opt.as_deref(),
        &icon,
        is_cataloged,
        &bytes,
    );

    // 手动选择持久化三件套：selected_url + level + icons 文件同 tick 落库（关掉重进还在）。
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
                // 真实 ext 落盘，绝不产生无扩展名文件（分流收敛在缝内）。
                let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
                let icon = IconRef::new(&remote_url, inferred_ext);
                let filename = persist_icon_bytes(
                    &icons_dir,
                    state.db().ok().as_deref(),
                    &icon,
                    is_cataloged,
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
            let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&default_url).unwrap_or("png");
            // hash 候选（inferred 快路径 + KNOWN 全后缀兜底 + 7 天新鲜度）。
            let mut hash_candidates: Vec<String> = Vec::new();
            {
                let full = crate::sha256_digest_hex(default_url.trim().as_bytes());
                let hs = &full[..16.min(full.len())];
                hash_candidates.push(format!("{}.{}", hs, inferred_ext));
                for ext in KNOWN_ICON_EXTS {
                    if *ext == inferred_ext {
                        continue;
                    }
                    hash_candidates.push(format!("{}.{}", hs, ext));
                }
            }
            // 最高频读其二：首屏收录图标恢复路径，同样经 spawn_blocking 卸载；其余同步读不动。
            let mut hit_bytes: Option<Vec<u8>> = None;
            for fname in hash_candidates {
                let p = icons_dir.join(&fname);
                if !crate::commands::icons::is_icon_file_fresh(&p) {
                    continue;
                }
                if let Some(b) = read_valid_image_file_async(p).await {
                    hit_bytes = Some(b);
                    break;
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
        let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
        let icon = IconRef::new(&remote_url, inferred_ext);
        if let Some(bytes) = read_level_cache_file(&icons_dir, &icon) {
            // 文件命中亦固化选中态（selected+level+文件三件套），下次 existing 直命中 N=0。
            // 文件名反查：hash 候选（与 read 同序）。
            let mut hit_fname = String::new();
            if !remote_url.trim().is_empty() {
                let full = crate::sha256_digest_hex(remote_url.trim().as_bytes());
                let hs = &full[..16.min(full.len())];
                let mut cands: Vec<String> = vec![format!("{}.{}", hs, inferred_ext)];
                for ext in KNOWN_ICON_EXTS {
                    if *ext == inferred_ext {
                        continue;
                    }
                    cands.push(format!("{}.{}", hs, ext));
                }
                for c in cands {
                    let p = icons_dir.join(&c);
                    if crate::commands::icons::is_icon_file_fresh(&p) && p.is_file() {
                        hit_fname = c;
                        break;
                    }
                }
            }
            crate::db::icon_cycle::seal_cycle_selection(
                &mut temp_cycle,
                lvl,
                &remote_url,
                hit_fname,
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

        // 文件缺失但有 remote_url 时尝试恢复（单一写入 + 单一下载落点）
        if !remote_url.is_empty() {
            let client = crate::commands::icons::icon_http_client();
            if let Ok(bytes) = download_via_mirror(&state, &client, &remote_url).await {
                let icon = IconRef::new(&remote_url, inferred_ext);
                let fn_non = persist_icon_bytes(
                    &icons_dir,
                    state.db().ok().as_deref(),
                    &icon,
                    false,
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

        // 下载失败/无文件：仍落库探测到的 l2..l4（下次 0 探，仅剩下载 1 次），不丢备选。
        {
            // 非收录 level 永不落 1（first_available 已保证 lvl>=2）。
            temp_cycle.level = lvl;
            if let Ok(db) = state.db() {
                let _ = db.upsert_icon_cycle(&temp_cycle);
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
