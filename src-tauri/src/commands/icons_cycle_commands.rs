use super::icons_cycle_probe::{
    KNOWN_ICON_EXTS, download_icon_bytes_direct, empty_cycle_result, ensure_cycle_levels,
    first_available_level, is_fallback_for_level, load_split_cached_bytes, next_cycle_level,
    write_icon_file, read_level_cache_file, read_valid_image_file_async, resolve_app_coord,
    source_for_level, IconCycleResult, IconRef,
};
use crate::AppState;
use tauri::State;

// C1 薄适配器：L1–L5 UI 轮换仅非收录应用可切（收录恒 L1，不切换）；
// 探测经 `ensure_cycle_levels`（L2/L3-live 走 `icon_fetch` 深核，L4 走 `probe_readme` 头部备选 Logo，
// 正文图永不进链），持久化经单一写入路径 `write_icon_file`（hash 单轨
// `sha256(url)[0:16]+sniff ext`），下载经 `download_icon_bytes_direct`，
// L5 空选经 `seal_empty_selection` +
// `empty_cycle_result`（清选中态 + `sync_detail_icon("")`），detail 同步内联
//（`data:` 永不进盘，`""` 显式清空）。
// 手动选择持久化三件套：`selected_url + level + icons 文件` 同 tick 落库（kubenav/GNS3 首次 N=1 之后 N=0）。
// 本文件只做编排，不写探测与文件名规则；图标通道禁用 ETag（命中 0 请求，7 天 TTL）。
// 两命令按阶段函数编排：校验 → 装载/探测 → 落库 → 结果构造（见各段函数头注释）。

/// 循环切换应用图标 (L1..=L5)
#[tauri::command(rename_all = "camelCase")]
pub async fn cycle_app_icon(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    // 校验段：坐标归一 + 收录早返（收录恒 L1，不切换，防误调）。
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();
    if is_cataloged {
        return restore_or_fetch_icon_cycle(state, app_id).await;
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let icons_dir = ensure_icons_dir();

    // 装载段：现有轮换行补齐 / 新行播种探测。
    let mut cycle = load_or_seed_cycle(
        &state,
        &canonical_id,
        &owner,
        &repo,
        is_cataloged,
        catalog_item.as_ref(),
        token.as_deref(),
    )
    .await;

    // 计算下一个推进级别（非收录跳 L1：next 绝不落 1，见 `next_cycle_level`；收录恒 L1 已早返）
    let next_level = next_cycle_level(cycle.level, &cycle);

    // Level 5: 空（始终可用，直接置空，无需下载；L5 "" 收敛在缝内）。
    // 同 hash 同 ext 的非选中文件保留不删，配额 LRU 按 mtime 淘汰。
    if next_level == 5 {
        seal_empty_level_selection(&state, &canonical_id, &mut cycle);
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

    let client = crate::forge::http::new_icon_client(
        crate::config::get_project_config().network.api_timeout_seconds,
    )
    .unwrap_or_default();

    // 字节装载段：本地 hash 候选（7 天 TTL，0 请求命中）→ 收录分流缓存 → 远端下载。
    let bytes =
        match load_cycle_target_bytes(&state, &icons_dir, &target_url, is_cataloged, &client).await
        {
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
        };

    // 落库段：三件套同 tick 落库 + detail 同步 + data uri 结果构造。
    Ok(persist_manual_selection(
        &state,
        &icons_dir,
        &canonical_id,
        &mut cycle,
        next_level,
        target_url,
        &bytes,
    ))
}

/// 只读恢复应用当前图标状态
#[tauri::command(rename_all = "camelCase")]
pub async fn restore_or_fetch_icon_cycle(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    // 校验段：坐标归一 + 收录态判定。
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    // 已有轮换行：L5 空态 / 新鲜文件快径 / 过期重下 / 空图兜底。
    if let Some(cycle) = existing {
        return restore_existing_cycle(&state, &canonical_id, cycle, is_cataloged).await;
    }
    // 尚未记录过轮换状态：收录回默认档。
    if is_cataloged {
        return restore_cataloged_default(catalog_item.as_ref()).await;
    }
    // 未收录且未落库：探测后返回首个有效级别，无有效则走 L5 首字母徽章逻辑。
    probe_uncataloged_first_cycle(&state, &canonical_id, &owner, &repo).await
}

/// icons 目录确保存在（缺失即创建，best-effort）并返回路径。
fn ensure_icons_dir() -> std::path::PathBuf {
    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }
    icons_dir
}

/// 图标字节下载（按配置超时构建 icon 客户端，失败退化默认；单一下载落点直调）。
async fn download_icon_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = crate::forge::http::new_icon_client(
        crate::config::get_project_config().network.api_timeout_seconds,
    )
    .unwrap_or_default();
    download_icon_bytes_direct(&client, url).await
}

/// hash 候选文件名序列（inferred 快路径 + KNOWN 全后缀兜底；与落盘 hash 单轨同序）。
fn hash_candidate_filenames(url: &str, inferred_ext: &str) -> Vec<String> {
    let full = crate::sha256_digest_hex(url.trim().as_bytes());
    let hs = &full[..16.min(full.len())];
    let mut candidates = vec![format!("{}.{}", hs, inferred_ext)];
    for ext in KNOWN_ICON_EXTS {
        if *ext == inferred_ext {
            continue;
        }
        candidates.push(format!("{}.{}", hs, ext));
    }
    candidates
}

/// 装载段：现有轮换行经 `ensure_cycle_levels` 补齐缺失级别（非收录且仍 L1 跳首个可用级），
/// 无行建新行探测后定级（收录恒 L1，未收录取首个可用级）。
async fn load_or_seed_cycle(
    state: &AppState,
    canonical_id: &str,
    owner: &str,
    repo: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) -> crate::db::AppIconCycle {
    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(canonical_id).ok().flatten());
    match existing {
        Some(mut c) => {
            ensure_cycle_levels(
                &mut c,
                state,
                owner,
                repo,
                canonical_id,
                is_cataloged,
                catalog_item,
                token,
            )
            .await;
            if !is_cataloged && c.level == 1 {
                c.level = first_available_level(&c).unwrap_or(2);
            }
            c
        }
        None => {
            let mut c = crate::db::AppIconCycle::new(canonical_id, owner, repo);
            c.is_cataloged = is_cataloged;
            ensure_cycle_levels(
                &mut c,
                state,
                owner,
                repo,
                canonical_id,
                is_cataloged,
                catalog_item,
                token,
            )
            .await;
            c.level = if is_cataloged {
                1
            } else {
                first_available_level(&c).unwrap_or(2)
            };
            c
        }
    }
}

/// L5 空选落库段：封空选中 + pinned（手动轮换保护）+ 落库 + detail 同步显式清空 ""。
fn seal_empty_level_selection(
    state: &AppState,
    canonical_id: &str,
    cycle: &mut crate::db::AppIconCycle,
) {
    crate::db::icon_cycle::seal_empty_selection(cycle);
    // 02 手动轮换保护：用户手动切档即 pinned，后续详情刷新只补槽不改选中。
    cycle.pinned = true;
    if let Ok(db) = state.db() {
        let _ = db.upsert_icon_cycle(cycle);
        // 写侧同步内联（原 sync_detail_icon_best_effort）：L5 显式清空 ""，有行才 UPDATE。
        let _ = db.sync_detail_icon(canonical_id, "");
    }
}

/// 字节装载段：本地 hash 候选（7 天 TTL，0 请求命中）→ 收录分流缓存
/// （`load_split_cached_bytes`）→ 远端下载（单一下载落点；失败透传 Err，不推进 level）。
async fn load_cycle_target_bytes(
    state: &AppState,
    icons_dir: &std::path::Path,
    target_url: &str,
    is_cataloged: bool,
    client: &reqwest::Client,
) -> Result<Vec<u8>, String> {
    // 检查本地是否已存在缓存文件（hash 候选 + 7 天 TTL，0 请求命中）。
    let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(target_url).unwrap_or("png");
    let icon = IconRef::new(target_url, inferred_ext);
    let mut cached_bytes = if !is_cataloged {
        read_level_cache_file(icons_dir, &icon)
    } else {
        None
    };
    if cached_bytes.is_none() {
        if let Ok(db) = state.db() {
            if is_cataloged {
                cached_bytes = load_split_cached_bytes(icons_dir, &db, &icon, true, None);
            }
        }
    }
    match cached_bytes {
        Some(b) => Ok(b),
        // 从远端下载（经单一落点）；失败交调用方记 warn 并中止。
        None => download_icon_bytes_direct(client, target_url).await,
    }
}

/// 手动选择落库段（三件套同 tick）：单一写入路径落盘，随后 seal（selected_url+level+文件）、
/// pinned、落库、detail 同步（`data:` 永不进盘，有行才 UPDATE，cached_at 不动），
/// 最终构造 data uri 结果（is_cataloged 恒 false：收录行在命令入口已早返）。
fn persist_manual_selection(
    state: &AppState,
    icons_dir: &std::path::Path,
    canonical_id: &str,
    cycle: &mut crate::db::AppIconCycle,
    next_level: i32,
    target_url: String,
    bytes: &[u8],
) -> IconCycleResult {
    // 单一写入路径（FINAL hash 单轨，不在命令层双分支；`data:` 永不进盘由下 sync 守卫）。
    let db_opt = state.db().ok();
    let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&target_url).unwrap_or("png");
    let icon = IconRef::new(&target_url, inferred_ext);
    // is_cataloged 恒 false：收录行在命令入口已早返（保持 false 与拆分前实参一致）。
    let final_filename = write_icon_file(icons_dir, db_opt.as_deref(), &icon, false, bytes);

    // 手动选择持久化三件套：selected_url + level + icons 文件同 tick 落库（关掉重进还在）。
    crate::db::icon_cycle::seal_cycle_selection(cycle, next_level, &target_url, final_filename);
    // 02 手动轮换保护：用户手动切档即 pinned，后续详情刷新只补槽不改选中。
    cycle.pinned = true;
    if let Some(db) = db_opt.as_ref() {
        let _ = db.upsert_icon_cycle(cycle);
        // 写侧同步内联（原 thin helper）：`data:` 永不进盘，有行才 UPDATE，cached_at 不动。
        let sel = cycle.selected_url.trim();
        if !sel.starts_with("data:") {
            let _ = db.sync_detail_icon(canonical_id, sel);
        }
    }

    let data_uri = crate::commands::icons::bytes_to_data_uri(bytes);
    IconCycleResult {
        url: data_uri,
        remote_url: target_url,
        level: next_level,
        source: source_for_level(next_level).to_string(),
        is_fallback: is_fallback_for_level(next_level),
        total_levels: 5,
        is_cataloged: false,
    }
}

/// 已有轮换行恢复段：L5 空态直返；新鲜文件快径（spawn_blocking 卸载，文件 7 天 + 行 7 天
/// 双检）；过期/缺失经 remote_url 重下（单一写入 + 单一下载落点 + `set_icon_cycle_selected`
/// 固化，pinned 选择由此保持）；全失回空图构造（level/remote_url 仍透出）。
async fn restore_existing_cycle(
    state: &AppState,
    canonical_id: &str,
    cycle: crate::db::AppIconCycle,
    is_cataloged: bool,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");

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
        // 03 过期刷新：恢复路径与请求路径同口径判鲜（文件 7 天新鲜 + 行 7 天有效双检），
        // 任一过期即走下载分支，不直接返回旧图；pinned 选择由下载分支 `set_icon_cycle_selected` 保持。
        let now = crate::now_secs();
        let cache_path = icons_dir.join(&cycle.cache_file);
        let file_fresh = crate::commands::icons::is_icon_file_fresh(&cache_path);
        if crate::db::icon_cycle::is_cycle_restore_fresh(&cycle, file_fresh, now) {
            // 最高频读：经 spawn_blocking 卸载，避免阻塞 async 运行时。
            if let Some(bytes) = read_valid_image_file_async(cache_path).await {
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
    }

    // 文件缺失但有 remote_url 时尝试恢复（单一写入 + 单一下载落点）
    if !remote_url.is_empty() {
        if let Ok(bytes) = download_icon_bytes(&remote_url).await {
            // 真实 ext 落盘，绝不产生无扩展名文件（分流收敛在缝内）。
            let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
            let icon = IconRef::new(&remote_url, inferred_ext);
            let filename = write_icon_file(
                &icons_dir,
                state.db().ok().as_deref(),
                &icon,
                is_cataloged,
                &bytes,
            );

            if let Ok(db) = state.db() {
                let _ = db.set_icon_cycle_selected(canonical_id, lvl, &remote_url, &filename);
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

    Ok(IconCycleResult {
        url: String::new(),
        remote_url,
        level: lvl,
        source: source_for_level(lvl).to_string(),
        is_fallback: is_fallback_for_level(lvl),
        total_levels: 5,
        is_cataloged,
    })
}

/// 收录应用初始段（无轮换行）：收录默认图标经 hash 候选命中即返 L1 实图；
/// 未命中按默认 URL 有无返回 L1/L5 空态构造。
async fn restore_cataloged_default(
    catalog_item: Option<&crate::github::CatalogItem>,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let default_url = catalog_item
        .map(|i| i.icon.trim().to_string())
        .unwrap_or_default();

    if !default_url.is_empty() {
        let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&default_url).unwrap_or("png");
        // hash 候选（inferred 快路径 + KNOWN 全后缀兜底 + 7 天新鲜度）。
        // 最高频读其二：首屏收录图标恢复路径，同样经 spawn_blocking 卸载；其余同步读不动。
        let mut hit_bytes: Option<Vec<u8>> = None;
        for fname in hash_candidate_filenames(&default_url, inferred_ext) {
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
    Ok(IconCycleResult {
        url: String::new(),
        remote_url: default_url,
        level: lvl,
        source: source_for_level(lvl).to_string(),
        is_fallback: is_fallback_for_level(lvl),
        total_levels: 5,
        is_cataloged: true,
    })
}

/// 未收录应用首轮探测段：ensure 探测 → 本地文件命中即固化三件套（selected+level+文件，
/// 下次 existing 直命中 N=0）→ 缺文件经 remote_url 重下并固化 →
/// 全失仍落库探测到的 l2..l4（下次 0 探，仅剩下载 1 次）→ 无有效级别走 L5 空态。
async fn probe_uncataloged_first_cycle(
    state: &AppState,
    canonical_id: &str,
    owner: &str,
    repo: &str,
) -> crate::AppResult<IconCycleResult> {
    let icons_dir = crate::get_app_data_dir().join("icons");
    let token = crate::commands::resolve_active_github_token(state);
    let mut temp_cycle = crate::db::AppIconCycle::new(canonical_id, owner, repo);
    temp_cycle.is_cataloged = false;
    ensure_cycle_levels(
        &mut temp_cycle,
        state,
        owner,
        repo,
        canonical_id,
        false,
        None,
        token.as_deref(),
    )
    .await;

    let Some(lvl) = first_available_level(&temp_cycle) else {
        // 无有效则走 L5 首字母徽章逻辑（空态统一构造）
        return Ok(empty_cycle_result(false));
    };
    let remote_url = temp_cycle.url_for_level(lvl).unwrap_or("").trim().to_string();
    let inferred_ext = crate::commands::icons::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
    let icon = IconRef::new(&remote_url, inferred_ext);
    if let Some(bytes) = read_level_cache_file(&icons_dir, &icon) {
        // 文件命中亦固化选中态（selected+level+文件三件套），下次 existing 直命中 N=0。
        // 文件名反查：hash 候选（与 read 同序）。
        let mut hit_fname = String::new();
        if !remote_url.trim().is_empty() {
            for c in hash_candidate_filenames(&remote_url, inferred_ext) {
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
        if let Ok(bytes) = download_icon_bytes(&remote_url).await {
            let icon = IconRef::new(&remote_url, inferred_ext);
            let fn_non = write_icon_file(
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
}
