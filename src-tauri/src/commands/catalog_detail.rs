use crate::models::{
    AppDetail, AppSummary, HydratedRepoCard, PlatformsLiteResult, ReadmeVariantsResponse,
};
use crate::repositories::{card_hydrator, detail_service, DetailSources};
use crate::AppState;
use tauri::State;

/// 应用详情：网络默认允许；TTL 命中直返缓存，否则走 ETag 条件请求拉取并落库。
/// `force_refresh` 为手动刷新按钮透传位，`Some(true)` 时跳过 TTL 与 ETag 复用、直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_app_details(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<AppDetail> {
    let clean_id = crate::commands::require_app_id(&id)?;
    detail_service::resolve_app_detail(
        &state,
        DetailSources::default(),
        &clean_id,
        force_refresh.unwrap_or(false),
    )
    .await
}

/// 平台轻量回填：优先命中收录目录与 TTL 内缓存，未命中时仅拉取 latest release 推导平台列表（不写 `app_details`）。
/// `force_refresh = Some(true)` 时跳过缓存快径直探远端。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_platforms_lite(
    state: State<'_, AppState>,
    id: String,
    force_refresh: Option<bool>,
) -> crate::AppResult<PlatformsLiteResult> {
    let clean_id = crate::commands::require_app_id(&id)?;
    detail_service::resolve_platforms_lite(
        &state,
        DetailSources::default(),
        &clean_id,
        force_refresh.unwrap_or(false),
    )
    .await
}

/// 批量读取本地缓存的应用详情摘要（无网络、只读）：优先读详情与富卡缓存，缺失时回退收录目录。
#[tauri::command]
pub async fn get_cached_app_details_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<AppSummary>>> {
    card_hydrator::cached_summaries(&state, &ids).await
}

/// 批量读取已确认的本地图标（无网络、不触发后台补图）：优先 `app_icon_cycles`，其次收录项官方图标。
#[tauri::command]
pub async fn get_confirmed_icons_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<String>>> {
    let jobs = {
        let db = state.db()?;
        let pendings: Vec<crate::icons::PendingIcon> = ids
            .iter()
            .map(|raw| {
                let clean_id = crate::forge::canonical_app_id(raw.trim()).unwrap_or_default();
                crate::icons::PendingIcon::for_clean_id(&state.catalog, &clean_id)
            })
            .collect();
        crate::icons::plan_pending_icons(&db, &pendings)
    };
    let icons = crate::icons::resolve_icons_offloaded(&state, jobs).await;
    Ok(icons)
}

/// 批量水合单仓富卡（无网络）：收录项投影目录元数据，未收录项读 `repo_card_cache`（缺失回退 `app_details`），
/// 并叠加确认图标与收录标记。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_repo_cards_batch(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> crate::AppResult<Vec<Option<HydratedRepoCard>>> {
    card_hydrator::repo_cards(&state, &ids).await
}

/// 批量本地水合合集应用概要（零网络）：用于 `zstore://collection` 预览弹窗。
#[tauri::command(rename_all = "camelCase")]
pub async fn resolve_collection_apps(
    state: State<'_, AppState>,
    app_ids: Vec<String>,
) -> crate::AppResult<Vec<AppSummary>> {
    card_hydrator::collection_apps(&state, &app_ids).await
}

/// 通用图片磁盘缓存查询：命中或下载后返回 `data:` URI，失败回退原地址。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_or_cache_asset_url(
    state: State<'_, AppState>,
    url: String,
    app_id: Option<String>,
) -> crate::AppResult<String> {
    let app = app_id.unwrap_or_default();
    Ok(crate::github::asset_fetch::fetch_or_cache_asset_url_inner(&state.db, &url, &app).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_readme_variants(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<ReadmeVariantsResponse> {
    // 归一化入站 id；未知标识直接拒绝，避免触碰网络。
    let clean_id = crate::commands::require_app_id(&app_id)?;
    if let Ok(db) = state.db() {
        let ttl_secs = detail_service::detail_ttl_secs(&db);
        if ttl_secs > 0 {
            if let Ok(Some(cached)) = db.get_app_detail(&clean_id, Some(ttl_secs)) {
                if let Some(variants) = cached.readme_variants {
                    if !variants.is_empty() {
                        return Ok(ReadmeVariantsResponse { variants });
                    }
                }
            }
        }
    }
    let token = crate::commands::resolve_active_github_token(&state);
    let variants = state
        .catalog
        .fetch_readme_variants(&clean_id, token.as_deref(), None)
        .await?;
    if !variants.is_empty() {
        if let Ok(db) = state.db() {
            let _ = db.update_detail_readme_variants(&clean_id, &variants);
        }
    }
    Ok(ReadmeVariantsResponse { variants })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SimilarAppItem {
    pub app: AppSummary,
    pub similarity: f64,
    pub reasons: Vec<crate::github::affinity::Reason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternatives: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SimilarAppsResponse {
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_alternatives: Vec<String>,
    pub items: Vec<SimilarAppItem>,
}

/// `get_similar_apps` 共享规划阶段：短锁取隐藏规则与待解析确认图标计划后立即释放 `state.db()`。
#[allow(clippy::too_many_arguments)]
fn plan_similar_apps(
    state: &AppState,
    app_id: &str,
    name: Option<&str>,
    owner: Option<&str>,
    category: Option<&str>,
    description: Option<&str>,
    description_en: Option<&str>,
    limit: Option<usize>,
) -> crate::AppResult<(
    crate::github::catalog_service::SimilarAppsPlan,
    Vec<crate::icons::DeferredIcon>,
)> {
    let clean_id = crate::commands::require_app_id(app_id)?;
    let hidden_ids: std::collections::HashSet<String> = super::hidden_rule_ids(state)?
        .into_iter()
        .map(|id| id.to_lowercase())
        .collect();

    let plan = state.catalog.find_similar_apps(
        &crate::github::catalog_service::SimilarAppSeed {
            clean_id: &clean_id,
            name,
            owner,
            category,
            description,
            description_en,
        },
        &hidden_ids,
        limit,
    );

    let jobs = if let Ok(db) = state.db() {
        let pendings: Vec<crate::icons::PendingIcon> = plan
            .items
            .iter()
            .map(|entry| {
                crate::icons::PendingIcon::confirmed(
                    &entry.app.core.id,
                    &entry.app.core.owner,
                    &entry.app.core.repo,
                )
            })
            .collect();
        crate::icons::plan_pending_icons(&db, &pendings)
    } else {
        Vec::new()
    };

    Ok((plan, jobs))
}

fn finish_similar_apps(
    plan: crate::github::catalog_service::SimilarAppsPlan,
) -> SimilarAppsResponse {
    let items = plan
        .items
        .into_iter()
        .map(|entry| {
            let alternatives = entry.app.core.alternatives.clone();
            SimilarAppItem {
                app: entry.app,
                similarity: entry.similarity,
                reasons: entry.reasons,
                alternatives,
            }
        })
        .collect();

    SimilarAppsResponse {
        target_id: plan.target_id,
        target_alternatives: plan.target_alternatives,
        items,
    }
}

/// `get_similar_apps` 核心同步执行逻辑（拆出供单测直测；磁盘图标读与 base64 编码均在 `state.db()` 锁外完成）。
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn get_similar_apps_sync(
    state: &AppState,
    app_id: &str,
    name: Option<&str>,
    owner: Option<&str>,
    category: Option<&str>,
    description: Option<&str>,
    description_en: Option<&str>,
    limit: Option<usize>,
) -> crate::AppResult<SimilarAppsResponse> {
    let (mut plan, jobs) = plan_similar_apps(
        state,
        app_id,
        name,
        owner,
        category,
        description,
        description_en,
        limit,
    )?;

    if !jobs.is_empty() {
        let icons_dir = crate::get_app_data_dir().join("icons");
        let (icons, heals) = crate::icons::materialize_icons(&icons_dir, &jobs);
        if !heals.is_empty() {
            if let Ok(db) = state.db() {
                crate::icons::apply_icon_cache_heals(&db, &heals);
            }
        }
        crate::icons::patch_core_icons(
            plan.items.iter_mut().map(|e| Some(&mut e.app.core)),
            icons,
        );
    }

    Ok(finish_similar_apps(plan))
}

/// 详情页「相似开源项目」推荐（零网络复用 `CatalogDerived` 词袋 IDF 与 `seed_similarity_with_idf`）。
/// DB 规划与磁盘确认图标读取完全解耦，图标读取卸载至阻塞线程池。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn get_similar_apps(
    state: State<'_, AppState>,
    app_id: String,
    name: Option<String>,
    owner: Option<String>,
    category: Option<String>,
    description: Option<String>,
    description_en: Option<String>,
    limit: Option<usize>,
) -> crate::AppResult<SimilarAppsResponse> {
    let (mut plan, jobs) = plan_similar_apps(
        &state,
        &app_id,
        name.as_deref(),
        owner.as_deref(),
        category.as_deref(),
        description.as_deref(),
        description_en.as_deref(),
        limit,
    )?;

    if !jobs.is_empty() {
        crate::icons::resolve_and_patch_icons(
            &state,
            jobs,
            plan.items.iter_mut().map(|e| Some(&mut e.app.core)),
        )
        .await;
    }

    Ok(finish_similar_apps(plan))
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
            core: crate::models::AppCore {
                id: app_id.to_string(),
                name: "testrepo".to_string(),
                description_en: None,
                owner: "testowner".to_string(),
                repo: "testrepo".to_string(),
                icon: String::new(),
                icon_bg: crate::github::http::DEFAULT_ICON_BG.to_string(),
                description: "A test project".to_string(),
                stars: 10,
                forks: 2,
                license: "MIT".to_string(),
                latest_version: "1.0.0".to_string(),
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                is_verified: false,
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: Vec::new(),
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
        };

        if let Some(ci) = crate::icons::resolve_confirmed_icon_from_db(
            &db,
            &summary.core.id,
            &summary.core.owner,
            &summary.core.repo,
        ) {
            summary.core.icon = ci;
        }

        assert!(summary.core.icon.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(&test_file_path);
    }
}

#[cfg(test)]
mod repo_card_hydration_tests {
    use super::*;
    use crate::db::{Database, RepoCardUpsert};
    use crate::models::AppCore;

    fn test_state() -> AppState {
        AppState {
            db: std::sync::Arc::new(std::sync::Mutex::new(Database::open_in_memory().unwrap())),
            catalog: crate::github::CatalogService::new_empty(),
            mirror: std::sync::Mutex::new(crate::mirror::MirrorManager::new()),
            github_token: std::sync::Mutex::new(None),
            sync_lock: tokio::sync::Mutex::new(()),
            startup_catalog_synced: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn card(id: &str, platforms: &[&str], confirmed_other: bool) -> RepoCardUpsert {
        let (owner, repo) = id.split_once('/').unwrap();
        RepoCardUpsert {
            summary: AppSummary {
                core: AppCore {
                    id: id.to_string(),
                    name: repo.to_string(),
                    description_en: None,
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    icon: "https://avatars.githubusercontent.com/u/9".to_string(),
                    icon_bg: String::new(),
                    description: "Real tool".to_string(),
                    stars: 42,
                    forks: 1,
                    license: "MIT".to_string(),
                    latest_version: "v1.0.0".to_string(),
                    category: "external".to_string(),
                    category_name: "跨平台开源".to_string(),
                    is_verified: false,
                    forge: Some("github".to_string()),
                    forge_host: Some("github.com".to_string()),
                    homepage: None,
                    platforms: platforms.iter().map(|p| p.to_string()).collect(),
                    is_cataloged: Some(false),
                    source: None,
                    status: None,
                    added_at: None,
                    alternatives: Vec::new(),
                },
            },
            confirmed_other,
            is_private: Some(false),
        }
    }

    fn curated(id: &str) -> crate::github::CatalogItem {
        let (owner, repo) = id.split_once('/').unwrap();
        crate::github::CatalogItem {
            id: id.to_string(),
            name: "精选".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: "https://official.example/logo.png".to_string(),
            icon_bg: String::new(),
            description: "精选简介".to_string(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v9".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 1,
            forks: 1,
            is_verified: true,
            homepage: None,
            platforms: vec!["windows".to_string()],
            identifiers: Default::default(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
        }
    }

    #[test]
    fn similar_apps_response_serializes_without_empty_alternatives() {
        let resp = SimilarAppsResponse {
            target_id: "o/r".to_string(),
            target_alternatives: Vec::new(),
            items: vec![SimilarAppItem {
                app: card("o/peer", &["windows"], false).summary,
                similarity: 0.72,
                reasons: vec![crate::github::affinity::Reason::Category {
                    category: "dev".to_string(),
                }],
                alternatives: Vec::new(),
            }],
        };
        let val = serde_json::to_value(&resp).unwrap();
        assert_eq!(val["target_id"], "o/r");
        assert!(val.get("target_alternatives").is_none());
        assert!(val["items"][0].get("alternatives").is_none());
        assert_eq!(val["items"][0]["reasons"][0]["kind"], "category");
    }

    #[test]
    fn get_similar_apps_sync_covers_curated_external_hidden_and_empty() {
        let state = test_state();
        let mut rustdesk = curated("rustdesk/rustdesk");
        rustdesk.name = "RustDesk".to_string();
        rustdesk.category = "system".to_string();
        rustdesk.description = "远程桌面控制工具 remote desktop control".to_string();
        rustdesk.stars = 50_000;

        let mut peer_same_owner = curated("rustdesk/rustdesk-server");
        peer_same_owner.name = "RustDesk Server".to_string();
        peer_same_owner.category = "system".to_string();
        peer_same_owner.description = "远程桌面自建中继服务 remote desktop relay".to_string();
        peer_same_owner.stars = 4_000;

        let mut hidden_peer = curated("acme/hidden-remote");
        hidden_peer.name = "Hidden Remote".to_string();
        hidden_peer.category = "system".to_string();
        hidden_peer.description = "远程桌面控制工具 remote desktop control".to_string();
        hidden_peer.stars = 10_000;

        let mut unrelated = curated("other/music-box");
        unrelated.name = "Music Box".to_string();
        unrelated.category = "media".to_string();
        unrelated.description = "无损音频播放器 lossless audio player".to_string();
        unrelated.stars = 2_000;

        state
            .catalog
            .update_items(vec![rustdesk, peer_same_owner, hidden_peer, unrelated]);
        state
            .db()
            .unwrap()
            .set_hidden_status("acme/hidden-remote", true)
            .unwrap();

        // 1. 已收录 seed：排除自身与隐藏条目，并产出 Reason::Owner / target_alternatives
        let curated_res = get_similar_apps_sync(
            &state,
            "RustDesk/RustDesk",
            None,
            None,
            None,
            None,
            None,
            Some(4),
        )
        .unwrap();
        assert_eq!(curated_res.target_id, "rustdesk/rustdesk");
        assert!(curated_res
            .target_alternatives
            .iter()
            .any(|a| a == "TeamViewer"));
        let ids: Vec<&str> = curated_res
            .items
            .iter()
            .map(|e| e.app.core.id.as_str())
            .collect();
        assert_eq!(ids, vec!["rustdesk/rustdesk-server"]);
        assert!(curated_res.items[0]
            .reasons
            .iter()
            .any(|r| matches!(r, crate::github::affinity::Reason::Owner { .. })));

        // 2. 未收录动态 seed：利用入参元数据匹配同赛道目录项
        let ext_res = get_similar_apps_sync(
            &state,
            "moonlight-stream/moonlight-qt",
            Some("Moonlight"),
            Some("moonlight-stream"),
            Some("system"),
            Some("远程桌面串流控制 remote desktop streaming"),
            None,
            Some(4),
        )
        .unwrap();
        assert_eq!(ext_res.target_id, "moonlight-stream/moonlight-qt");
        assert!(ext_res.target_alternatives.iter().any(|a| a == "Parsec"));
        assert!(ext_res
            .items
            .iter()
            .any(|e| e.app.core.id == "rustdesk/rustdesk"));

        // 3. 零结果边界
        let empty_res = get_similar_apps_sync(
            &state,
            "unknown/isolated",
            Some("Isolated"),
            Some("unknown"),
            Some("games"),
            Some("completely disjoint domain token"),
            None,
            Some(4),
        )
        .unwrap();
        assert!(empty_res.items.is_empty());
    }

    #[test]
    fn similar_apps_icon_materialization_runs_outside_db_lock() {
        let state = test_state();
        let mut seed = curated("rustdesk/rustdesk");
        seed.name = "RustDesk".to_string();
        seed.category = "system".to_string();
        seed.description = "远程桌面控制工具 remote desktop control".to_string();

        let mut peer = curated("rustdesk/rustdesk-server");
        peer.name = "RustDesk Server".to_string();
        peer.category = "system".to_string();
        peer.description = "远程桌面自建中继服务 remote desktop relay".to_string();
        state.catalog.update_items(vec![seed, peer]);

        let dir = tempfile::tempdir().unwrap();
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";
        std::fs::write(dir.path().join("peer.png"), png).unwrap();
        let mut cycle =
            crate::db::AppIconCycle::new("rustdesk/rustdesk-server", "rustdesk", "rustdesk-server");
        cycle.level = 3;
        cycle.l3_url = "https://example.com/peer.png".to_string();
        cycle.selected_url = cycle.l3_url.clone();
        cycle.cache_file = "peer.png".to_string();
        cycle.updated_at = crate::now_secs();
        state.db().unwrap().upsert_icon_cycle(&cycle).unwrap();

        let (mut plan, jobs) = plan_similar_apps(
            &state,
            "rustdesk/rustdesk",
            None,
            None,
            None,
            None,
            None,
            Some(4),
        )
        .unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(jobs.len(), 1);

        // 证明规划完成后 state.db 锁已释放，磁盘读与 base64 编码在锁外执行。
        let _held_elsewhere = state
            .db
            .try_lock()
            .expect("plan_similar_apps must release state.db lock before disk I/O");
        let (icons, _heals) = crate::icons::materialize_icons(dir.path(), &jobs);
        crate::icons::patch_core_icons(
            plan.items.iter_mut().map(|e| Some(&mut e.app.core)),
            icons,
        );
        let res = finish_similar_apps(plan);
        assert!(res.items[0]
            .app
            .core
            .icon
            .starts_with("data:image/png;base64,"));
    }
}
