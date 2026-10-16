use crate::models::{AppDetail, PlatformsLiteResult, ReadmeVariantsResponse};
use crate::AppState;
use tauri::State;

/// 落库门（真空语义）：仅 stale 穿透/合成空失败（`is_stale==Some(true)`）跳过持久化；
/// fresh（含 200 真空双空）一律落盘——真空以 fresh 空行落盘（`is_stale=None`，
/// `cached_at=now`），下次 TTL 内命中直接复用，前端灭黄标。
/// 401/离线仍黄（skip 保持旧行），200 真空不黄（persist fresh 空行）。
pub(crate) fn should_skip_persist(is_stale: Option<bool>) -> bool {
    is_stale == Some(true)
}

/// FINAL 详情 TTL（分钟→秒）：分钟数经 `get_detail_cache_ttl_minutes`
///（内用 `get_or_config`，DB 设置优先、挡位归一、缺省回退 config 基线）已归一，
/// 此处仅做单位换算。
/// - `0`（每次实时校验）原样透传 0；
/// - 其余一律 `m * 60`（挡位合法性由 DB 层保证，不做二次钳制）。
/// 图标 TTL 另见 `db::icon_cycle::ICON_TTL_SECS`（7 天，图标通道禁用 ETag）。
pub(crate) fn detail_ttl_secs(db: &crate::db::Database) -> i64 {
    let m = db.get_detail_cache_ttl_minutes();
    if m <= 0 {
        return 0;
    }
    m * 60
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
/// `lazyBackfillPlatforms` 仅需 deduced platforms，
/// 此处仅做单次 `releases/latest` ETag 条件请求 + `platforms_from_assets` 推导。
///
/// 语义与 `get_app_details_impl` 对齐（仅做减法）：
/// - TTL 内详情缓存命中（`get_detail_cache_ttl_minutes()*60`）直接复用已 deduce 的
///   platforms，`from_cache=true`；
/// - miss 时仅 GET `releases/latest`（`get_with_etag` 复用 304/200/ETag 与限流上报），
///   无 repo、无 README、无图标探测、无 checksum；`detail_json` 仅 TTL 命中时复用，
///   网络路径只解析 release assets；
/// - 304-touch/save/回退决议收归 `github::release_fetch` shallow adapter
///   （与 Streaming Update Check〈流式更新检查〉同一 interface）：
///   304 命中经 payload 恢复 deduce 并 `touch_cached_app_detail` 延长保鲜期
///   （`from_cache=true`，与详情 304 短路同形）；
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
    // TTL 口径与 get_app_details_impl 缓存链一致（FINAL 60min，见 `detail_ttl_secs`）；stale 标记原样透传
    // （持久化行正常为 None，透传仅为防御性一致）。图标 ETag 禁用不影响此通道（详情 ETag 仍用）。
    if let Ok(db) = state.db() {
        let ttl_seconds = detail_ttl_secs(&db);
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
                platforms: crate::github::detail_assets::platforms_from_assets(&release_info.assets),
                from_cache: false,
                is_stale: None,
            });
        }
    }

    // 3. GitHub：release_endpoint + ETag 条件请求（仅 releases/latest 单次 RTT）。
    // 未知坐标时沿用详情降级：stale 旧行穿透标 stale，无行则拒绝（前端一律视为 loading）。
    let (release_endpoint, cached_etag, cached_payload) = {
        if let Err(e) = state.catalog.get_repo_coordinates(&clean_id) {
            if let Ok(db) = state.db() {
                if let Ok(Some(fallback)) = db.get_cached_app_detail(&clean_id, None) {
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

    // 收敛：304-touch/save/回退分支收归 `github::release_fetch` shallow adapter
    //（与 Streaming Update Check〈流式更新检查〉同一 interface）。
    // ADR-0007 豁免对照分支（consult_ttl = true 侧）：本通道入口已先走 Cache TTL 快径
    // （见上）；更新检查通道无此分支，每次直探。语义见模块注释。
    // 304 payload 腐坏报硬错"解析本地 ETag 缓存失败"（更新检查侧 tolerant 跳过）。
    // Fresh 无需回退源，避免无谓 DB 读。
    // touch/save 双效应经 `apply_release_cache_effects` 单口执行。
    let stale_row: Option<crate::models::AppDetail> = match &outcome {
        EtagGetOutcome::Fresh { .. } => None,
        _ => state
            .db()
            .ok()
            .and_then(|db| db.get_cached_app_detail(&clean_id, None).ok().flatten()),
    };
    match crate::github::release_fetch::decide_shallow_release(
        &outcome,
        cached_payload.as_deref(),
        stale_row.as_ref(),
        None,
    ) {
        Ok(rel) => {
            if let Ok(db) = state.db() {
                crate::github::release_fetch::apply_release_cache_effects(
                    &db,
                    &release_endpoint,
                    &clean_id,
                    rel.touch,
                    rel.cache_to_save,
                    crate::now_secs(),
                );
            }
            let platforms = match rel.row_platforms {
                // 旧行穿透：直接采用已 deduce platforms，不重推导。
                Some(p) => p,
                None => state.catalog.deduce_lite_platforms(&clean_id, &rel.assets),
            };
            // 日志 from= 文案：304-行/离线-payload 穿透本无日志，仅 miss/304/stale 三臂标注。
            let from_label: Option<&str> = match (&rel.source, rel.touch) {
                (crate::github::release_fetch::ShallowSource::Fresh, _) => Some("miss"),
                (crate::github::release_fetch::ShallowSource::Payload, true) => {
                    Some("cache:304")
                }
                (crate::github::release_fetch::ShallowSource::StaleRow, false) => {
                    Some("cache:stale")
                }
                _ => None,
            };
            if let Some(from) = from_label {
                log::debug!(
                    "get_platforms_lite id={} from={} elapsed_ms={}",
                    clean_id,
                    from,
                    start.elapsed().as_millis()
                );
            }
            Ok(PlatformsLiteResult {
                id: clean_id,
                platforms,
                from_cache: !matches!(
                    rel.source,
                    crate::github::release_fetch::ShallowSource::Fresh
                ),
                is_stale: rel.stale,
            })
        }
        Err(crate::github::release_fetch::ShallowError::Parse(e)) => Err(e.into()),
        Err(crate::github::release_fetch::ShallowError::PayloadCorrupt(e)) => {
            // 304 进臂时已 touch 延保（UPDATE 无行即空操作），硬错前补上。
            if let Ok(db) = state.db() {
                let _ = db.touch_cached_app_detail(&clean_id, crate::now_secs());
            }
            Err(e.into())
        }
        Err(crate::github::release_fetch::ShallowError::Miss(miss)) => match miss {
            crate::github::release_fetch::ShallowMiss::NotModifiedWithoutCache => {
                Err("304 响应但本地未找到缓存数据".into())
            }
            crate::github::release_fetch::ShallowMiss::OfflineWithoutCache => {
                // 合成空失败：无任何缓存时以 stale 区分于成功空（与详情同形），
                // 前端 stale-empty 视为 loading，不确认 Other；本命令永不落库。
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
        },
    }
}

/// P0 stale 契约：瞬时失败（401/限流/离线）永不污染 SQLite。
/// - 合成空（无缓存失败）以 `is_stale=true` 返回，调用方跳过落库，无旧行则不建行；
/// - stale 穿透（复用旧行）保持旧行不动（含 `cached_at` 不刷新），`Ok(stale)` 为 IPC 形状约定；
/// - 前端必须将 `stale + releases/platforms 双空` 视为 loading/待 backfill-loading，永不确认 Other。
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
    // FINAL 详情 TTL 60min（见 `detail_ttl_secs`；platforms_lite 同值）。
    if !is_force {
        let cached: Option<AppDetail> = state.db().ok().and_then(|db| {
            let ttl_seconds = detail_ttl_secs(&db);
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
            let platforms =
                crate::github::detail_assets::platforms_from_assets(&release_info.assets);
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
                // Top2：详情 + 图标原子落库（2 提交变 1 提交），事务边界见 `save_detail_with_cycle_row`；
                // 失败整体回滚并回退逐条，保持 `let _ =` 吞错 + 下次重试语义，不改 TTL/ETag。
                let icon_trimmed = detail.icon.trim();
                let staged_cycle: Option<crate::db::AppIconCycle> =
                    if !icon_trimmed.is_empty() {
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
                    .save_detail_with_cycle_row(&clean_id, &detail, staged_cycle.as_ref())
                    .is_err()
                {
                    let _ = db.save_cached_app_detail(&clean_id, &detail);
                    if let Some(c) = staged_cycle.as_ref() {
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
                // 未知坐标降级同样标 stale，Ok(stale) 形状 IPC 保留，前端 stale-empty 视为 loading。
                if let Ok(db) = state.db() {
                    if let Ok(Some(mut fallback)) = db.get_cached_app_detail(&clean_id, None) {
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
            db.get_cached_app_detail(&clean_id, None).ok().flatten()
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
            // 日志诚实区分：真 304（to_cache=None + 非 stale）vs stale/failed 合成空或穿透
            //（to_cache=None + is_stale==Some(true)），避免 stale 误标为 304 误导下次诊断。
            let cache_type = if to_cache.is_some() {
                "miss"
            } else if detail.is_stale == Some(true) {
                "stale/failed"
            } else {
                "304"
            };
            log::debug!(
                "fetch app detail done id={} url='{}' cache={} elapsed_ms={}",
                clean_id,
                safe_ep,
                cache_type,
                start.elapsed().as_millis()
            );
            let now = crate::now_secs();
            detail.cached_at = Some(now);

            // release ETag 副作用经 `release_fetch::apply_release_cache_effects` 单口执行
            //（touch 侧 stale 守卫：stale 穿透永不 touch，避免把过期 stale 洗成 fresh）。
            // 语义对照：to_cache=Some 为远端 200（落库 ETag 键）；to_cache=None + 非 stale
            // 为远端 304（仅 touch 延保，零配额；fresh 真空经 304 恢复同样走此延保，
            // 经 200 则走 save 并由下方落盘分支以 fresh 空行落盘，下次 TTL 内不再变黄）。
            if let Ok(db) = state.db() {
                let touch_on_304 =
                    to_cache.is_none() && detail.is_stale != Some(true);
                crate::github::release_fetch::apply_release_cache_effects(
                    &db,
                    &release_endpoint,
                    &clean_id,
                    touch_on_304,
                    to_cache,
                    now,
                );
            }

            // 存入 SQLite 本地持久化缓存。
            // inherit-then-recompute：远端产物为空但本地已有资产时先继承，
            // 继承后若 releases 非空而 platforms 仍空则重算 deduce，
            // 使 assets-without-platforms 不可能成立。
            // never-poison：仅 stale 穿透/合成空失败（is_stale==Some(true)）
            // 永不落库——有旧行则保持旧行（连 cached_at 都不刷新），无旧行则不建行；
            // 返回的 detail 保持 Ok 形状，但 is_stale=true 供前端视为
            // loading/待 backfill-loading，永不确认 Other。空平台不 stamp ["other"]/["windows"]。
            // 真空落盘：fresh 双空（200 已问到，仅全过滤致 releases/platforms 双空、
            // is_stale 非 true）为远端确认无有效安装包，以 fresh 空行落盘
            // （is_stale=None，cached_at=now），下次 TTL 内命中直接复用，前端灭黄标。
            let start_db = std::time::Instant::now();
            log::debug!("db_save start id={} sid={} req={}", clean_id, sid, req_id);
            if let Ok(db) = state.db() {
                if detail.releases.is_empty() {
                    if let Ok(Some(old)) = db.get_cached_app_detail(&clean_id, None) {
                        if !old.releases.is_empty() {
                            detail.releases = old.releases.clone();
                        }
                    }
                }
                // 继承后重算：deduce 已在域内完成，此处仅补继承带来的缺口；
                // 成功 deduce 路径本身不动，排序 ORDER 与过滤规则沿用 SSOT。
                if !detail.releases.is_empty() && detail.platforms.is_empty() {
                    detail.platforms =
                        crate::github::detail_assets::platforms_from_assets(&detail.releases);
                }
                // stale 穿透（含合成空失败）：保持旧行不动（含 cached_at），直接返回。
                // fresh（含 200 真空双空）一律落盘，判定见 should_skip_persist。
                if should_skip_persist(detail.is_stale) {
                    log::debug!(
                        "db_save skip id={} sid={} req={} reason=stale_passthrough_keep_prior",
                        clean_id,
                        sid,
                        req_id
                    );
                } else {
                    // fresh 双空（200 已问到、is_stale 非 true、releases/platforms 双空）
                    // 为远端确认真空：同样落盘 fresh 空行（is_stale=None，cached_at=now），
                    // 下次 TTL 内命中直接复用，前端灭黄标（virtual-Other）。
                    // 落盘前占位根治：未收录仓 detail 占位简介若能从 ETag repo 真值回填则替换，
                    // 避免占位永久落盘导致 recents 永远吐占位；已收录仓人工精校优先直接跳过。
                    // （fetch 侧 B1 已用 fresh repo_info 治愈，此处补 repo 401/失败但 ETag 仍有旧真值的缺口；同步读不触网。）
                    if state.catalog.get_catalog_item(&clean_id).is_none() {
                        let need_desc =
                            crate::github::detail_fetch::is_placeholder_description(
                                &detail.description,
                            );
                        let need_en = detail
                            .description_en
                            .as_deref()
                            .map(
                                crate::github::detail_fetch::is_placeholder_description,
                            )
                            .unwrap_or(false);
                        let need_en_missing = detail
                            .description_en
                            .as_ref()
                            .map(|s| s.trim().is_empty())
                            .unwrap_or(true);
                        if need_desc || need_en || need_en_missing {
                            if let Some(real) =
                                crate::github::detail_fetch::repo_real_description_from_etag(
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
                    // FINAL Logo 口径：`detail.icon` 必为 L1–L4 备选 Logo（官方/探测/README 头部），
                    // README 正文图永不进 `detail.icon`（见 detail_fetch 头部 40 行 Logo 提取），此处不存正文。
                    // 02 手动轮换保护：pinned 行（用户已手动选择档位）保持 level/selected_url，
                    // 仅把本次最强探测补进备选槽，并把 `detail.icon` 对齐 pinned 选择
                    // （L5 pinned 对齐 `""` 保持徽章态）；未 pinned 行仍按最强探测更新选中图。
                    let icon_trimmed = detail.icon.trim().to_owned();
                    let staged_cycle: Option<crate::db::AppIconCycle> =
                        if !icon_trimmed.trim().is_empty()
                            && !crate::github::icon_fetch::is_body_image_url(&icon_trimmed)
                        {
                            let level =
                                crate::github::icon_fetch::level_for_detail_icon(&icon_trimmed);

                            let mut cycle = db
                                .get_icon_cycle(&clean_id)
                                .ok()
                                .flatten()
                                .unwrap_or_else(|| {
                                    crate::db::AppIconCycle::new(&clean_id, &detail.owner, &detail.repo)
                                });

                            if crate::db::icon_cycle::merge_detail_icon(
                                &mut cycle,
                                level,
                                icon_trimmed.trim(),
                                state.catalog.get_catalog_item(&clean_id).is_some(),
                                now,
                            ) {
                                detail.icon = cycle.selected_url.clone();
                            }
                            Some(cycle)
                        } else {
                            // 探测无可用图标：pinned 行仍保持详情展示为用户所选档位。
                            if let Ok(Some(pinned_cycle)) = db.get_icon_cycle(&clean_id) {
                                if pinned_cycle.pinned {
                                    detail.icon = pinned_cycle.selected_url.clone();
                                }
                            }
                            None
                        };
                    if db
                        .save_detail_with_cycle_row(&clean_id, &detail, staged_cycle.as_ref())
                        .is_err()
                    {
                        let _ = db.save_cached_app_detail(&clean_id, &detail);
                        if let Some(c) = staged_cycle.as_ref() {
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
            // Ok(stale) 形状为 IPC 保留；is_stale=true 供前端视为 loading，
            // stale-empty（双空）不得确认 Other，由 backfill 重试。
            if let Ok(db) = state.db() {
                if let Ok(Some(mut fallback_detail)) = db.get_cached_app_detail(&clean_id, None)
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

/// 通用图片磁盘缓存查询：已缓存返回本地路径，未命中下载后返回本地路径，失败回退原地址。
#[tauri::command]
pub async fn fetch_or_cache_asset_url(
    url: String,
    app_id: Option<String>,
) -> crate::AppResult<String> {
    let app = app_id.unwrap_or_default();
    Ok(crate::github::asset_fetch::fetch_or_cache_asset_url_inner(&url, &app).await)
}

/// 查询通用图片磁盘缓存占用：返回条目数与总字节。
#[tauri::command]
pub fn get_asset_cache_stats(
    state: State<'_, AppState>,
) -> crate::AppResult<crate::db::AssetUsageStats> {
    let db = state.db()?;
    Ok(db.asset_usage_stats()?)
}

/// 清空通用图片磁盘缓存：仅删除配额目录文件与图片缓存两表。
#[tauri::command]
pub fn clear_asset_cache(state: State<'_, AppState>) -> crate::AppResult<usize> {
    let db = state.db()?;
    let assets_dir = crate::get_app_data_dir().join("cache").join("assets");
    Ok(db.clear_asset_cache(&assets_dir)?)
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
    use crate::github::detail_assets::platforms_from_assets;
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
    fn persist_gate_only_stale_skips_fresh_true_empty_persists() {
        // 401/离线/合成空失败（stale）→ 跳过落库，保持旧行（仍黄，待 backfill）。
        assert!(super::should_skip_persist(Some(true)));
        // 200 真空（fresh，非 stale，双空）→ 落盘 fresh 空行（灭黄标）。
        assert!(!super::should_skip_persist(None));
        assert!(!super::should_skip_persist(Some(false)));
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
