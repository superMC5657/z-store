use crate::models::{AppDetail, PlatformsLiteResult, ReadmeVariantsResponse, ReleaseAsset};
use crate::AppState;
use tauri::State;

/// 通过 `installer::classify_asset` 的操作系统标签，从 Release 产物中推导支持的平台列表。
///
/// 与 `github::detail::platforms_from_assets` 对齐（不再分叉）：
/// 源码包 / <=1MB 占位包 / 校验签名元数据先经 `is_valid_installer_asset` 过滤；
/// `.msix` 归 windows；结果按 windows/macos/linux/ios/android 排序。
/// 若推导结果为空，则明确返回空向量 —— 此处特意不设置
/// 回退到 `["windows"]` 的兜底，确保仅限 Linux 或包含 Android 的发布版本绝不会被错误标记。
/// 前端 `matchPlatformSet` 如何处理缺失/空列表由前端规则决定。
pub(crate) fn platforms_from_assets(assets: &[ReleaseAsset]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for a in assets {
        if !crate::github::detail::is_valid_installer_asset(&a.name, a.size_bytes) {
            continue;
        }
        let (_, os, _) = crate::installer::classify_asset(&a.name);
        if os != "all" {
            set.insert(os.to_string());
        } else if a.name.to_lowercase().ends_with(".msix") {
            set.insert("windows".to_string());
        }
    }
    let mut plats: Vec<String> = set.into_iter().collect();
    crate::github::detail::sort_platforms(&mut plats);
    plats
}

#[tauri::command]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    Ok(get_app_details_impl(&state, id, force_refresh).await?)
}

/// 平台轻量回填（`get_platforms_lite`）：列表平台懒回填专用通道。
///
/// 动机：`lazyBackfillPlatforms` 仅需 deduced platforms，但此前复用全量
/// `get_app_details`（releases + repo + README + 图标探测 + checksum，miss 时秒级），
/// 此处仅做单次 `releases/latest` ETag 条件请求 + `platforms_from_assets` 推导。
///
/// 语义与 `get_app_details_impl` 对齐（行为不变，仅做减法）：
/// - TTL 内详情缓存命中（`get_detail_cache_ttl_minutes()*60`）直接复用已 deduce 的
///   platforms，`from_cache=true`；
/// - miss 时仅 GET `releases/latest`（`get_with_etag` 复用 304/200/ETag 与限流上报），
///   无 repo、无 README、无图标探测、无 checksum；`detail_json` 仅 TTL 命中时复用，
///   网络路径只解析 release assets；
/// - 304 命中经 payload 恢复 deduce 并 `touch_cached_app_detail` 延长保鲜期
///  （`from_cache=true`，与详情 304 短路同形）；
/// - stale 穿透（401/离线复用旧行）标 `is_stale=true` 且不 touch（与详情一致，
///   避免把过期 stale 洗成 fresh）；
/// - 空 platforms 明确返回空向量，不 stamp `["other"]`/`["windows"]`；
///   `other` 仍为纯前端虚拟概念，永不过 IPC。
/// 本命令永不写入 `app_details_cache`（不构造全量 `AppDetail`，避免污染详情缓存），
/// 仅读写 `api_etag_cache`（条件请求键）与详情 `cached_at` touch。
#[tauri::command]
pub async fn get_platforms_lite(
    state: State<'_, AppState>,
    id: String,
) -> crate::AppResult<PlatformsLiteResult> {
    use crate::github::http::EtagGetOutcome;

    // ADR-0010：入站 id 统一归一化为 canonical；未知标识直接拒绝，不触碰网络。
    let clean_id = crate::commands::require_app_id(&id)?;
    let start = std::time::Instant::now();

    // 1. TTL 内详情缓存命中：零网络开销复用已 deduce 的 platforms。
    // TTL 口径与 get_app_details_impl 缓存链一致（分钟*60）；stale 标记原样透传
    // （持久化行正常为 None，透传仅为防御性一致）。
    if let Ok(db) = state.db() {
        let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
        if let Ok(Some(cached)) = db.get_cached_app_detail(&clean_id, Some(ttl_seconds)) {
            log::debug!(
                "get_platforms_lite id={} from=cache:db elapsed_ms={}",
                clean_id,
                start.elapsed().as_millis()
            );
            return Ok(PlatformsLiteResult {
                id: clean_id,
                platforms: cached.platforms,
                from_cache: true,
                is_stale: cached.is_stale,
            });
        }
    }

    // 2. 多源（Codeberg/Gitea 等）穿透：仅拉 latest release，deduce 即返。
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            let host_token = if let Ok(db) = state.db() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            let release_info = crate::forge::ForgeRegistry::fetch_latest_release(
                &coord,
                host_token.as_deref(),
            )
            .await?;
            log::debug!(
                "get_platforms_lite id={} from=forge:{} elapsed_ms={}",
                clean_id,
                coord.forge.as_str(),
                start.elapsed().as_millis()
            );
            return Ok(PlatformsLiteResult {
                id: clean_id,
                platforms: platforms_from_assets(&release_info.assets),
                from_cache: false,
                is_stale: None,
            });
        }
    }

    // 3. GitHub：release_endpoint + ETag 条件请求（仅 releases/latest 单次 RTT）。
    // 未知坐标时沿用详情降级：stale 旧行穿透标 stale，无行则拒绝（前端一律视为 pending）。
    let (release_endpoint, cached_etag, cached_payload) = {
        if let Err(e) = state.catalog.get_repo_coordinates(&clean_id) {
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    log::debug!(
                        "get_platforms_lite id={} from=cache:stale reason=unknown_coords elapsed_ms={}",
                        clean_id,
                        start.elapsed().as_millis()
                    );
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms: fallback.platforms,
                        from_cache: true,
                        is_stale: Some(true),
                    });
                }
            }
            return Err(e.into());
        }
        let coords = state.catalog.get_repo_coordinates(&clean_id)?;
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db()?;
        let etag = db.get_etag(&ep).ok().flatten();
        let payload = db.get_cached_payload(&ep).ok().flatten();
        (ep, etag, payload)
    };

    let token = crate::commands::resolve_active_github_token(&state);
    let headers = crate::github::http::token_headers(token.as_deref());
    let outcome = crate::github::http::get_with_etag(
        &state.http,
        &release_endpoint,
        None,
        &headers,
        cached_etag.as_deref(),
        "platforms-lite",
    )
    .await;

    // 401 统一经 check_auth_expired 通知 + warn（与详情 release 分支同语义）。
    if matches!(outcome, EtagGetOutcome::Unauthorized) {
        crate::check_auth_expired(401, &format!("op=platforms-lite id={}", clean_id));
    }

    match outcome {
        EtagGetOutcome::NotModified => {
            // 304：版本未变。仅刷新 cached_at 延长保鲜期（UPDATE 无行即空操作），
            // platforms 经 ETag payload 恢复 deduce；payload 缺失时回退过期详情行。
            if let Ok(db) = state.db() {
                let _ = db.touch_cached_app_detail(&clean_id, crate::now_secs());
            }
            if let Some(ref payload) = cached_payload {
                let parsed: crate::github::models::GitHubReleaseResponse =
                    serde_json::from_str(payload).map_err(|e| {
                        format!("解析本地 ETag 缓存失败: {}", e)
                    })?;
                let platforms = deduce_lite_platforms(&state, &clean_id, &parsed.assets);
                log::debug!(
                    "get_platforms_lite id={} from=cache:304 elapsed_ms={}",
                    clean_id,
                    start.elapsed().as_millis()
                );
                return Ok(PlatformsLiteResult {
                    id: clean_id,
                    platforms,
                    from_cache: true,
                    is_stale: None,
                });
            }
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms: fallback.platforms,
                        from_cache: true,
                        is_stale: fallback.is_stale,
                    });
                }
            }
            Err("304 响应但本地未找到缓存数据".into())
        }
        EtagGetOutcome::Fresh { text, etag } => {
            let parsed: crate::github::models::GitHubReleaseResponse =
                serde_json::from_str(&text)
                    .map_err(|e| format!("解析 GitHub Release 失败: {}", e))?;
            // 远端 200：刷新 ETag 缓存表（有 etag 才存，与详情 to_cache 语义一致）。
            if let Some(ref et) = etag {
                if let Ok(db) = state.db() {
                    let _ = db.save_etag(&release_endpoint, et, &text, crate::now_secs());
                }
            }
            let platforms = deduce_lite_platforms(&state, &clean_id, &parsed.assets);
            log::debug!(
                "get_platforms_lite id={} from=miss elapsed_ms={}",
                clean_id,
                start.elapsed().as_millis()
            );
            Ok(PlatformsLiteResult {
                id: clean_id,
                platforms,
                from_cache: false,
                is_stale: None,
            })
        }
        EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed => {
            // 离线/限流/401：stale 穿透复用旧行（不 touch，保持旧行不动），
            // 标记 is_stale=true 供前端视为 pending，永不确认 Other。
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                    log::debug!(
                        "get_platforms_lite id={} from=cache:stale elapsed_ms={}",
                        clean_id,
                        start.elapsed().as_millis()
                    );
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms: fallback.platforms,
                        from_cache: true,
                        is_stale: Some(true),
                    });
                }
            }
            // 有 ETag payload 则离线恢复 deduce（与详情 Failed+payload 恢复同形，视为成功）。
            if let Some(ref payload) = cached_payload {
                if let Ok(parsed) =
                    serde_json::from_str::<crate::github::models::GitHubReleaseResponse>(payload)
                {
                    let platforms = deduce_lite_platforms(&state, &clean_id, &parsed.assets);
                    return Ok(PlatformsLiteResult {
                        id: clean_id,
                        platforms,
                        from_cache: true,
                        is_stale: None,
                    });
                }
            }
            // P0 合成空失败：无任何缓存时以 stale 区分于成功空（与详情同形），
            // 前端 stale-empty 视为 pending，不确认 Other；本命令永不落库。
            log::debug!(
                "get_platforms_lite id={} from=empty:stale elapsed_ms={}",
                clean_id,
                start.elapsed().as_millis()
            );
            Ok(PlatformsLiteResult {
                id: clean_id,
                platforms: Vec::new(),
                from_cache: false,
                is_stale: Some(true),
            })
        }
    }
}

/// 轻量 deduce：GitHub release 原始资产 → 最小 `ReleaseAsset` 投影 →
/// 复用既有 `platforms_from_assets`（`is_valid_installer_asset` 过滤 + `classify_asset`
/// OS 推导），再叠加收录库 ios 并集（与 `get_app_details_impl` 终态 platforms 一致，
/// 排序 ORDER 复用 `sort_platforms` SSOT）。空推导明确返回空向量，不做任何兜底。
fn deduce_lite_platforms(
    state: &AppState,
    clean_id: &str,
    assets: &[crate::github::models::GitHubAssetResponse],
) -> Vec<String> {
    let lite: Vec<ReleaseAsset> = assets
        .iter()
        .map(|a| ReleaseAsset {
            name: a.name.clone(),
            download_url: String::new(),
            size_bytes: a.size,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        })
        .collect();
    let deduced = platforms_from_assets(&lite);
    if deduced.is_empty() {
        return Vec::new();
    }
    if let Some(item) = state.catalog.get_catalog_item(clean_id) {
        let mut set = std::collections::BTreeSet::new();
        for p in &deduced {
            set.insert(p.clone());
        }
        for p in &item.platforms {
            if p == "ios" {
                set.insert(p.clone());
            }
        }
        let mut list: Vec<String> = set.into_iter().collect();
        crate::github::detail::sort_platforms(&mut list);
        list
    } else {
        deduced
    }
}

/// P0 stale 契约：瞬时失败（401/限流/离线）永不污染 SQLite。
/// - 合成空（无缓存失败）以 `is_stale=true` 返回，调用方跳过落库，无旧行则不建行；
/// - stale 穿透（复用旧行）保持旧行不动（含 `cached_at` 不刷新），`Ok(stale)` 形状为 IPC 兼容保留；
/// - 前端必须将 `stale + releases/platforms 双空` 视为 pending/待 backfill，永不确认 Other。
pub async fn get_app_details_impl(
    state: &AppState,
    id: String,
    force_refresh: Option<bool>,
) -> Result<AppDetail, String> {
    // ADR-0010：入站 id 统一归一化为 canonical（小写 owner/repo / forge 前缀坐标）；未知标识直接拒绝
    let clean_id = crate::commands::require_app_id(&id)?;
    let is_force = force_refresh.unwrap_or(false);
    let start = std::time::Instant::now();
    // db_save 日志关联用：复用进程级 sid；req 复用线程级（空则新建，仅日志用途，不改并发）。
    let sid = crate::z_log::new_session_id();
    let req_id = {
        let cur = crate::z_log::current_req_id();
        if cur.is_empty() {
            crate::z_log::new_req_id()
        } else {
            cur
        }
    };

    // 1. 若非主动强制刷新，优先从 SQLite 本地持久化缓存中读取，实现 0ms 瞬间秒开
    // 单次临界区完成 TTL + 缓存读取 + verified 标记解析，避免同请求内多次加/解锁；
    // 注意：锁守卫不得跨越 await（Tauri 命令 Future 需 Send），故查询收拢于单闭包内。
    // 后续优化方向：r2d2 连接池（当前仍用全局 Mutex<Database>，见 ADR-0003；无 schema 变更）。
    // 非法/缺失 TTL 挡位由 db 层回退默认 30 分钟（ADR-0007 有效集 {0,10,30,60,360,1440}）。
    if !is_force {
        let cached: Option<AppDetail> = state.db().ok().and_then(|db| {
            let ttl_seconds = db.get_detail_cache_ttl_minutes() * 60;
            let detail = db
                .get_cached_app_detail(&clean_id, Some(ttl_seconds))
                .ok()
                .flatten()?;
            Some(detail)
        });
        if let Some(mut cached_detail) = cached {
            cached_detail.id = clean_id.clone();
            if let Some(cat_item) = state.catalog.get_catalog_item(&clean_id) {
                if cat_item.description_en.is_some() {
                    cached_detail.description_en = cat_item.description_en.clone();
                }
            }
            log::debug!(
                "get_app_details id={} from=cache:db elapsed_ms={}",
                clean_id,
                start.elapsed().as_millis()
            );
            return Ok(cached_detail);
        }
    }

    // 2. 本地无缓存或用户主动要求强制刷新，执行远程拉取
    // 2.1 多源 (Codeberg, Gitea 等) 穿透解析
    if let Some(coord) = crate::forge::RepositoryUrlParser::parse(&clean_id) {
        if coord.forge != crate::forge::ForgeType::GitHub {
            log::debug!(
                "fetch app detail multi-forge id={} host={} forge={:?}",
                clean_id,
                coord.host,
                coord.forge
            );
            let host_token = if let Ok(db) = state.db() {
                db.get_host_token(&coord.host).ok().flatten()
            } else {
                None
            };
            let (repo_info, release_info) = tokio::try_join!(
                crate::forge::ForgeRegistry::fetch_repo(&coord, host_token.as_deref()),
                crate::forge::ForgeRegistry::fetch_latest_release(&coord, host_token.as_deref())
            )?;
            let now = crate::now_secs();
            let platforms = platforms_from_assets(&release_info.assets);
            let detail = AppDetail {
                id: clean_id.clone(),
                name: repo_info.name.clone(),
                description_en: repo_info.description.clone(),
                owner: coord.owner,
                repo: coord.repo,
                icon: String::new(),
                icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
                description: repo_info.description.clone().unwrap_or_default(),
                stars: repo_info.stars,
                forks: repo_info.forks,
                license: "OpenSource".to_string(),
                latest_version: release_info.tag_name,
                changelog: release_info.body.unwrap_or_default(),
                is_verified: false,
                readme_markdown: format!(
                    "# {}\n\n{}",
                    repo_info.name,
                    repo_info.description.unwrap_or_default()
                ),
                readme_variants: None,
                releases: release_info.assets,
                category: "external".to_string(),
                category_name: "跨平台开源".to_string(),
                forge: Some(coord.forge.as_str().to_string()),
                forge_host: Some(coord.host),
                cached_at: Some(now),
                is_stale: None,
                homepage: repo_info.homepage.clone(),
                platforms,
            };

            // 存入 SQLite 本地持久化缓存，并动态更新内存中的收录库统计
            state.catalog.update_catalog_item_stats(
                &clean_id,
                Some(repo_info.stars),
                Some(repo_info.forks),
                Some(&detail.latest_version),
            );

            if let Ok(db) = state.db() {
                let start_db = std::time::Instant::now();
                log::debug!("db_save start id={} sid={} req={}", clean_id, sid, req_id);
                // Top2：详情 + 图标原子落库（2 提交变 1 提交），事务边界见 `save_detail_with_icon`；
                // 失败整体回滚并回退逐条，保持 `let _ =` 吞错 + 下次重试语义，不改 TTL/ETag。
                let icon_trimmed = detail.icon.trim();
                let is_avatar = crate::commands::is_avatar_url(icon_trimmed)
                    || (icon_trimmed.starts_with("https://github.com/") && icon_trimmed.ends_with(".png") && !icon_trimmed.contains("/raw/"));
                let pending_cycle: Option<crate::db::AppIconCycle> =
                    if !icon_trimmed.is_empty() && !is_avatar {
                        let mut cycle = db
                            .get_icon_cycle(&clean_id)
                            .ok()
                            .flatten()
                            .unwrap_or_else(|| {
                                crate::db::AppIconCycle::new(&clean_id, &detail.owner, &detail.repo)
                            });
                        cycle.is_cataloged = false;
                        cycle.level = 4;
                        cycle.l4_url = icon_trimmed.to_string();
                        cycle.selected_url = icon_trimmed.to_string();
                        cycle.updated_at = crate::now_secs();
                        Some(cycle)
                    } else {
                        None
                    };
                if db
                    .save_detail_with_icon(&clean_id, &detail, pending_cycle.as_ref())
                    .is_err()
                {
                    let _ = db.save_cached_app_detail(&clean_id, &detail);
                    if let Some(c) = pending_cycle.as_ref() {
                        let _ = db.upsert_icon_cycle(c);
                    }
                }
                log::debug!(
                    "db_save done id={} sid={} req={} elapsed_ms={}",
                    clean_id,
                    sid,
                    req_id,
                    start_db.elapsed().as_millis()
                );
            }

            return Ok(detail);
        }
    }

    // 2.2 GitHub 仓库拉取
    let (release_endpoint, cached_etag, cached_payload, token, cached_detail_opt) = {
        let token = crate::commands::resolve_active_github_token(state);
        let coords = match state.catalog.get_repo_coordinates(&clean_id) {
            Ok(c) => c,
            Err(e) => {
                // P0：未知坐标降级同样标 stale，Ok(stale) 形状 IPC 兼容，前端 stale-empty 视为 pending。
                if let Ok(db) = state.db() {
                    if let Ok(Some(mut fallback)) = db.get_cached_app_detail_fallback(&clean_id) {
                        fallback.id = clean_id.clone();
                        fallback.is_stale = Some(true);
                        log::debug!(
                            "fetch detail fallback id={} cache=stale elapsed_ms={}",
                            clean_id,
                            start.elapsed().as_millis()
                        );
                        return Ok(fallback);
                    }
                }
                return Err(e);
            }
        };
        let ep = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            coords.owner, coords.repo
        );
        let db = state.db()?;
        let (etag, payload) = if is_force {
            (None, None)
        } else {
            let etag = db.get_etag(&ep).ok().flatten();
            let payload = db.get_cached_payload(&ep).ok().flatten();
            (etag, payload)
        };
        let cached_detail = if is_force {
            None
        } else {
            db.get_cached_app_detail_fallback(&clean_id).ok().flatten()
        };
        (ep, etag, payload, token, cached_detail)
    };

    let safe_ep = crate::log_support::sanitize_url(&release_endpoint);
    log::debug!(
        "fetch app detail start id={} url='{}' force={}",
        clean_id,
        safe_ep,
        is_force
    );

    let fetch_result = state
        .catalog
        .fetch_app_detail(
            &clean_id,
            cached_etag,
            cached_payload,
            cached_detail_opt,
            token.as_deref(),
        )
        .await;

    match fetch_result {
        Ok((mut detail, to_cache)) => {
            let cache_type = if to_cache.is_none() { "304" } else { "miss" };
            log::debug!(
                "fetch app detail done id={} url='{}' cache={} elapsed_ms={}",
                clean_id,
                safe_ep,
                cache_type,
                start.elapsed().as_millis()
            );
            let now = crate::now_secs();
            detail.cached_at = Some(now);

            if let Some((etag, payload)) = to_cache {
                // 远端返回 200 OK，更新 ETag 缓存表
                if let Ok(db) = state.db() {
                    let _ = db.save_etag(&release_endpoint, &etag, &payload, now);
                }
            } else if detail.is_stale != Some(true) {
                // 远端返回 304 Not Modified（to_cache 为 None 且非 stale 穿透）
                // 仅刷新 cached_at 时间戳，零配额消耗延长保鲜期。
                // P0：stale 穿透（401/离线复用旧详情）不得 touch，避免把过期 stale 洗成 fresh。
                if let Ok(db) = state.db() {
                    let _ = db.touch_cached_app_detail(&clean_id, now);
                }
            }

            // 存入 SQLite 本地持久化缓存。
            // P0-1（inherit-then-recompute）：远端产物为空但本地已有资产时先继承，
            // 继承后若 releases 非空而 platforms 仍空则重算 deduce，
            // 使 assets-without-platforms 不可能成立。
            // P0-2（never-poison）：合成空失败（releases+platforms 双空）或 stale 穿透
            // 永不落库——有旧行则保持旧行（连 cached_at 都不刷新），无旧行则不建行；
            // 返回的 detail 保持 Ok 形状（IPC 兼容），但 is_stale=true 供前端视为
            // pending/待 backfill，永不确认 Other。空平台不 stamp ["other"]/["windows"]。
            let start_db = std::time::Instant::now();
            log::debug!("db_save start id={} sid={} req={}", clean_id, sid, req_id);
            if let Ok(db) = state.db() {
                if detail.releases.is_empty() {
                    if let Ok(Some(old)) = db.get_cached_app_detail_fallback(&clean_id) {
                        if !old.releases.is_empty() {
                            detail.releases = old.releases.clone();
                        }
                    }
                }
                // 继承后重算：deduce 已在 detail.rs 完成，此处仅补继承带来的缺口；
                // 成功 deduce 路径本身不动，排序 ORDER 与过滤规则沿用 SSOT。
                if !detail.releases.is_empty() && detail.platforms.is_empty() {
                    detail.platforms = platforms_from_assets(&detail.releases);
                }
                // stale 穿透：保持旧行不动（含 cached_at），直接返回。
                if detail.is_stale == Some(true) {
                    log::debug!(
                        "db_save skip id={} sid={} req={} reason=stale_passthrough_keep_prior",
                        clean_id,
                        sid,
                        req_id
                    );
                } else if detail.releases.is_empty() && detail.platforms.is_empty() {
                    // 双空（合成失败或真实零发布）：不建行、不覆盖旧行。
                    // 合成失败经 detail.rs 已标 stale；真实零发布保持 None，
                    // 前端双空+stale 视为 pending，双空+非 stale 视为真实空（virtual-Other）。
                    log::debug!(
                        "db_save skip id={} sid={} req={} reason=empty_empty_keep_prior",
                        clean_id,
                        sid,
                        req_id
                    );
                } else {
                    // 落盘前占位根治：未收录仓 detail 占位简介若能从 ETag repo 真值回填则替换，
                    // 避免占位永久落盘导致 recents 永远吐占位；已收录仓人工精校优先直接跳过。
                    // （fetch 侧 B1 已用 fresh repo_info 治愈，此处补 repo 401/失败但 ETag 仍有旧真值的缺口；同步读不触网。）
                    if state.catalog.get_catalog_item(&clean_id).is_none() {
                        let need_desc =
                            crate::github::detail::detail_fetch::is_placeholder_description(
                                &detail.description,
                            );
                        let need_en = detail
                            .description_en
                            .as_deref()
                            .map(
                                crate::github::detail::detail_fetch::is_placeholder_description,
                            )
                            .unwrap_or(false);
                        let need_en_missing = detail
                            .description_en
                            .as_ref()
                            .map(|s| s.trim().is_empty())
                            .unwrap_or(true);
                        if need_desc || need_en || need_en_missing {
                            if let Some(real) =
                                crate::github::detail::detail_fetch::repo_real_description_from_etag(
                                    &db,
                                    &detail.owner,
                                    &detail.repo,
                                )
                            {
                                if need_desc {
                                    detail.description = real.clone();
                                }
                                if need_en || need_en_missing {
                                    detail.description_en = Some(real);
                                }
                            }
                        }
                    }
                    // Top2：详情 + 图标原子落库（2 提交变 1 提交），失败回滚并回退逐条，不改 TTL/ETag。
                    let icon_trimmed = detail.icon.trim();
                    let is_avatar = crate::commands::is_avatar_url(icon_trimmed)
                        || (icon_trimmed.starts_with("https://github.com/") && icon_trimmed.ends_with(".png") && !icon_trimmed.contains("/raw/"));
                    let pending_cycle: Option<crate::db::AppIconCycle> =
                        if !icon_trimmed.is_empty() && !is_avatar {
                            let level = if icon_trimmed.contains("simpleicons.org") {
                                2
                            } else if icon_trimmed.contains("/blob/") || icon_trimmed.to_lowercase().contains("readme") {
                                4
                            } else {
                                3
                            };

                            let mut cycle = db
                                .get_icon_cycle(&clean_id)
                                .ok()
                                .flatten()
                                .unwrap_or_else(|| {
                                    crate::db::AppIconCycle::new(&clean_id, &detail.owner, &detail.repo)
                                });

                            cycle.is_cataloged = state.catalog.get_catalog_item(&clean_id).is_some();
                            cycle.level = level;
                            if level == 3 {
                                cycle.l3_url = icon_trimmed.to_string();
                            } else if level == 4 {
                                cycle.l4_url = icon_trimmed.to_string();
                            } else if level == 2 {
                                cycle.l2_url = icon_trimmed.to_string();
                            }
                            cycle.selected_url = icon_trimmed.to_string();
                            cycle.updated_at = now;
                            Some(cycle)
                        } else {
                            None
                        };
                    if db
                        .save_detail_with_icon(&clean_id, &detail, pending_cycle.as_ref())
                        .is_err()
                    {
                        let _ = db.save_cached_app_detail(&clean_id, &detail);
                        if let Some(c) = pending_cycle.as_ref() {
                            let _ = db.upsert_icon_cycle(c);
                        }
                    }
                } // end non-stale non-empty save branch (P0: stale/empty-empty skip above)
            }
            log::debug!(
                "db_save done id={} sid={} req={} elapsed_ms={}",
                clean_id,
                sid,
                req_id,
                start_db.elapsed().as_millis()
            );

            Ok(detail)
        }
        Err(err) => {
            log::warn!(
                "fetch app detail failed id={} url='{}' reason={}",
                clean_id,
                safe_ep,
                crate::log_support::short_reason(&err)
            );
            // 网络或限额异常时，优雅降级返回已存储的历史缓存。
            // P0：Ok(stale) 形状为 IPC 兼容保留；is_stale=true 供前端视为 pending，
            // stale-empty（双空）不得确认 Other，由 backfill 重试。
            if let Ok(db) = state.db() {
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail_fallback(&clean_id)
                {
                    fallback_detail.id = clean_id.clone();
                    fallback_detail.is_stale = Some(true);
                    log::debug!(
                        "fetch app detail fallback id={} from=cache:stale elapsed_ms={}",
                        clean_id,
                        start.elapsed().as_millis()
                    );
                    return Ok(fallback_detail);
                }
            }
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn get_readme_variants(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<ReadmeVariantsResponse> {
    // ADR-0010：入站 id 统一归一化为 canonical；未知标识直接拒绝，不触碰网络。
    // token 经服务端鉴权头透传（token_headers），永不回传前端。
    let clean_id = crate::commands::require_app_id(&app_id)?;
    let token = crate::commands::resolve_active_github_token(&state);
    let variants = state
        .catalog
        .fetch_readme_variants(&clean_id, token.as_deref(), None)
        .await?;
    Ok(ReadmeVariantsResponse { variants })
}

#[cfg(test)]
mod catalog_platform_tests {
    use super::platforms_from_assets;
    use crate::models::ReleaseAsset;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            download_url: String::new(),
            // is_valid 过滤要求 >1MB：默认给足体积，仅占位/签名类用例显式覆写。
            size_bytes: 20_000_000,
            sha256: None,
            os: String::new(),
            arch: String::new(),
            kind: String::new(),
        }
    }

    #[test]
    fn linux_only_release_must_not_be_labeled_windows() {
        let assets = vec![asset("app-1.0_amd64.deb"), asset("app-1.0.AppImage")];
        let plats = platforms_from_assets(&assets);
        assert_eq!(plats, vec!["linux".to_string()]);
    }

    #[test]
    fn android_containing_release_derives_android_without_windows_fallback() {
        let assets = vec![
            asset("app-arm64-v8a-release.apk"),
            asset("app-armeabi-v7a-release.apk"),
        ];
        let plats = platforms_from_assets(&assets);
        assert_eq!(plats, vec!["android".to_string()]);
    }

    #[test]
    fn unknown_only_assets_yield_explicit_empty_vec() {
        let assets = vec![asset("checksums.txt"), asset("README.md")];
        let plats = platforms_from_assets(&assets);
        assert!(plats.is_empty());
    }

    #[test]
    fn empty_assets_yield_explicit_empty_vec() {
        let plats = platforms_from_assets(&[]);
        assert!(plats.is_empty());
    }

    #[test]
    fn test_confirmed_icon_enrichment_logic() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let app_id = "testowner/testrepo";
        let test_filename = "testowner_testrepo_l2.png";
        let icons_dir = crate::get_app_data_dir().join("icons");
        let _ = std::fs::create_dir_all(&icons_dir);
        let test_file_path = icons_dir.join(test_filename);
        let png_bytes = b"\x89PNG\r\n\x1a\nfake png data";
        std::fs::write(&test_file_path, png_bytes).unwrap();

        let cycle = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: "testowner".to_string(),
            repo: "testrepo".to_string(),
            level: 2,
            selected_url: "https://example.com/icon.png".to_string(),
            cache_file: test_filename.to_string(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle).unwrap();

        let mut summary = crate::models::AppSummary {
            id: app_id.to_string(),
            name: "testrepo".to_string(),
            description_en: None,
            owner: "testowner".to_string(),
            repo: "testrepo".to_string(),
            icon: String::new(),
            icon_bg: "linear-gradient(135deg, #475569, #334155)".to_string(),
            description: "A test project".to_string(),
            stars: 10,
            forks: 2,
            license: "MIT".to_string(),
            latest_version: "1.0.0".to_string(),
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            is_verified: false,
            is_installed: None,
            has_update: None,
            installed_version: None,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage: None,
            platforms: Vec::new(),
        };

        if let Some(ci) = crate::github::http::resolve_confirmed_icon_from_db(
            &db,
            &summary.id,
            &summary.owner,
            &summary.repo,
        ) {
            summary.icon = ci;
        }

        assert!(summary.icon.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(&test_file_path);
    }
}
