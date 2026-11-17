use crate::models::AppSummary;
use crate::AppState;
use tauri::State;

/// 发现页卡片摘要（复用 `AppSummary` 形状，前端按 `AppSummary` 解析）。
pub type CatalogItemSummary = AppSummary;

/// 发现页分页载荷（serde 默认 snake_case，前端按 `{ limit, offset, seed }` invoke('get_home_feed')）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct FeedPage {
    pub items: Vec<CatalogItemSummary>,
    pub total: usize,
    pub has_more: bool,
    /// 平台预过滤前该分类/时间窗的全部非隐藏规范 ID（仅分类页与最新入库页回传）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_ids: Option<Vec<String>>,
}

/// 本地亲和度画像分类权重项（供设置页「本地推荐与隐私数据看板」只读展示）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct AffinityCategoryStat {
    pub category: String,
    pub weight: f64,
}

/// 本地亲和度画像审计摘要（100% 源自本地 SQLite 信号表，零云端上传）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct AffinityProfileSummary {
    /// 任一信号源开启即为个性化推荐。
    pub enabled: bool,
    /// 本地应用信息信号源（收藏、关注、已安装、浏览、搜索）。
    pub local_enabled: bool,
    /// GitHub 用户信息信号源（Star、Fork、自有仓库）。
    pub github_enabled: bool,
    pub starred_repo_count: usize,
    pub forked_repo_count: usize,
    pub owned_repo_count: usize,
    pub favorites_count: usize,
    pub watched_count: usize,
    pub top_categories: Vec<AffinityCategoryStat>,
    pub top_languages: Vec<String>,
    pub last_synced_at: Option<i64>,
    pub installed_count: usize,
    pub viewed_count: usize,
    pub search_query_count: usize,
    pub interest_seeds: Vec<String>,
    pub feedback_count: usize,
    pub signal_count: usize,
}

pub fn build_affinity_profile_summary(
    db: &crate::db::Database,
    catalog: &crate::github::CatalogService,
    now_secs: i64,
) -> crate::AppResult<AffinityProfileSummary> {
    let sources = crate::github::affinity::AffinitySources::load(db);
    let raw = db.load_raw_affinity_signals()?;

    let mut starred_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut forked_repo_count = 0usize;
    let mut owned_repo_count = 0usize;

    for sig in &raw.repo_signals {
        match sig.relation_kind() {
            Some(crate::db::RepoRelation::Starred) => {
                starred_set.insert(sig.full_name.trim().to_lowercase());
            }
            Some(crate::db::RepoRelation::Forked) => {
                forked_repo_count += 1;
            }
            Some(crate::db::RepoRelation::Owned) => {
                owned_repo_count += 1;
            }
            None => {}
        }
    }
    for (id, _) in &raw.user_stars {
        let clean = id.trim().to_lowercase();
        if !clean.is_empty() {
            starred_set.insert(clean);
        }
    }

    // 偏好分类与语言只反映当前开启的信号源；各项计数始终展示本地已存数据。
    let profile = catalog.build_affinity_profile(&raw, now_secs, sources);
    let top_categories = profile
        .top_categories(3)
        .into_iter()
        .map(|(category, weight)| AffinityCategoryStat { category, weight })
        .collect();
    let top_languages = if sources.github {
        crate::github::affinity::top_signal_languages(&raw, 3)
    } else {
        Vec::new()
    };
    let last_synced_at = db
        .get_setting(crate::github::affinity::SETTING_AFFINITY_GITHUB_SYNCED_AT)?
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|&ts| ts > 0);

    Ok(AffinityProfileSummary {
        enabled: sources.any(),
        local_enabled: sources.local,
        github_enabled: sources.github,
        starred_repo_count: starred_set.len(),
        forked_repo_count,
        owned_repo_count,
        favorites_count: raw.favorites.len(),
        watched_count: raw.watched.len(),
        top_categories,
        top_languages,
        last_synced_at,
        installed_count: raw.installed.len(),
        viewed_count: raw.views.len(),
        search_query_count: raw.searches.len(),
        interest_seeds: raw.interest_seeds.clone(),
        feedback_count: raw.feedback.len(),
        signal_count: profile.signal_count,
    })
}

/// 精选页冷启动：整体替换兴趣分类（仅接受 10 个标准分类 key）。
#[tauri::command]
pub fn save_interest_seeds(
    state: State<'_, AppState>,
    categories: Vec<String>,
) -> crate::AppResult<()> {
    let normalized = normalize_interest_categories(&categories)?;
    state.db()?.replace_interest_seeds(&normalized)?;
    Ok(())
}

/// 精选页「不感兴趣」（`scope = "app"`，`target` 为应用标识）或「少推这类」（`scope = "category"`，`target` 为分类 key）。
/// 「少推这类」从某张卡片发起时附带 `appId`，该卡片同时记一条应用级反馈。
#[tauri::command(rename_all = "camelCase")]
pub fn dismiss_featured(
    state: State<'_, AppState>,
    target: String,
    scope: String,
    app_id: Option<String>,
) -> crate::AppResult<()> {
    let db = state.db()?;
    record_featured_dismissal(&db, &target, &scope, app_id.as_deref(), crate::now_secs())
}

fn record_featured_dismissal(
    db: &crate::db::Database,
    target: &str,
    scope: &str,
    app_id: Option<&str>,
    now: i64,
) -> crate::AppResult<()> {
    let parsed =
        crate::db::FeedbackScope::parse(scope).ok_or_else(|| format!("未知的反馈范围：{scope}"))?;
    match parsed {
        crate::db::FeedbackScope::App => {
            let key = crate::forge::canonical_app_id(target)
                .ok_or_else(|| format!("无效的应用标识：{target}"))?;
            db.upsert_feed_feedback(&key, parsed, now)?;
        }
        crate::db::FeedbackScope::Category => {
            let mut v = normalize_interest_categories(&[target.to_string()])?;
            let cat = v.pop().ok_or_else(|| "分类不能为空".to_string())?;
            let app = match app_id.map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => Some(
                    crate::forge::canonical_app_id(raw)
                        .ok_or_else(|| format!("无效的应用标识：{raw}"))?,
                ),
                None => None,
            };
            db.upsert_category_and_app_feedback(&cat, app.as_deref(), now)?;
        }
    }
    Ok(())
}

/// 清空全部推荐负反馈，返回删除条数。
#[tauri::command]
pub fn clear_feed_feedback(state: State<'_, AppState>) -> crate::AppResult<usize> {
    Ok(state.db()?.clear_feed_feedback()?)
}

fn normalize_interest_categories(categories: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in categories {
        let key = raw.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        if !crate::db::custom_apps::OFFICIAL_CATEGORIES.contains(&key.as_str()) {
            return Err(format!("未知的分类：{raw}"));
        }
        if !out.contains(&key) {
            out.push(key);
        }
    }
    Ok(out)
}

/// 读取两个信号源开关并只用开启的信号构建画像；返回的 `bool` 为「任一信号源开启」。
/// 全部关闭时也构建：精选页仍需已安装与「不感兴趣」集合。数据库不可用时返回 `None`。
pub(crate) fn load_affinity_profile(
    state: &AppState,
) -> Option<(bool, crate::github::affinity::UserAffinityProfile)> {
    let db = state.db().ok()?;
    let sources = crate::github::affinity::AffinitySources::load(&db);
    let raw = db.load_raw_affinity_signals().ok()?;
    drop(db);
    let profile = state
        .catalog
        .build_affinity_profile(&raw, crate::now_secs(), sources);
    Some((sources.any(), profile))
}

#[tauri::command]
pub fn get_affinity_profile_summary(
    state: State<'_, AppState>,
) -> crate::AppResult<AffinityProfileSummary> {
    let db = state.db()?;
    build_affinity_profile_summary(&db, &state.catalog, crate::now_secs())
}

/// 立即同步推荐画像：拉取登录账号的 Star / Fork / 自有仓库写入 `user_repo_signals`（ETag 条件请求）。
#[tauri::command]
pub async fn sync_affinity_signals(state: State<'_, AppState>) -> crate::AppResult<usize> {
    let token = crate::commands::resolve_active_github_token(&state)
        .ok_or_else(|| "请先在「设置」中登录 GitHub 账号".to_string())?;
    let count =
        crate::github::CatalogService::sync_github_affinity_signals_bg(&state.db, &token, None)
            .await?;
    crate::notify_affinity_updated();
    Ok(count)
}

/// 发现页 Feed（分页 + 混排，含本地收录合并视图）：
/// - 输入为远端目录 + 本地收录（collected 系/`submitted` 且未归档）合并，可搜可装与远端同行为；
/// - `total`=过滤后总量，`has_more`=(offset+limit)<total（saturating，边界守好）；
/// - `seed`=None 时纯 stars 降序（确定性），Some(seed)+balanced 时轻扰动打散头部垄断；
/// - `strategy`=None/非法时回退 balanced（大小写不敏感，前端原样透传、后端归一小写）；
/// - hero 置顶留给前端，后端不 hardcode 具体 id；
/// - 前端按 `invoke('get_home_feed', { limit, offset, seed, strategy })` 调用
///   （`seed`/`strategy` 可省略/传 null）。
#[tauri::command]
pub fn get_home_feed(
    state: State<'_, AppState>,
    limit: usize,
    offset: usize,
    seed: Option<u64>,
    strategy: Option<String>,
) -> Result<FeedPage, String> {
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(&state)?;
    let filtered: Vec<AppSummary> = state
        .catalog
        .merged_summaries_filtered(|item| !hidden_ids.contains(&item.id));
    let ranked = {
        use crate::github::catalog_feed_score as score;
        let parsed = score::parse_feed_strategy(strategy.as_deref());
        if parsed == score::FeedStrategy::Balanced {
            // 画像增益只在个性化开启且有信号时生效；「不感兴趣」沉底与打散不受开关影响。
            let loaded = load_affinity_profile(&state);
            let boost_profile = loaded
                .as_ref()
                .filter(|(enabled, p)| *enabled && p.has_signals)
                .map(|(_, p)| p);
            let ranked = score::rank_feed_with_profile(filtered, seed, parsed, boost_profile);
            let empty = std::collections::HashSet::new();
            let sunk_ids = loaded
                .as_ref()
                .map(|(_, p)| &p.dismissed_app_ids)
                .unwrap_or(&empty);
            score::diversify_and_sink(ranked, sunk_ids)
        } else {
            score::rank_feed_with_profile(filtered, seed, parsed, None)
        }
    };
    let (items, total, has_more) =
        crate::github::catalog_feed_score::paginate_feed(&ranked, limit, offset);
    Ok(FeedPage {
        items,
        total,
        has_more,
        matched_ids: None,
    })
}

/// 类别页分页（与发现页 `FeedPage` 同形 `{items,total,has_more}`，含本地收录合并视图）：
/// - `page`/`per_page` 均为 None=默认（第 1 页 20 条，与发现页 `HOME_FEED_PAGE`、在线搜索对齐）；
/// - `per_page` 复用搜索钳制 1-50（`clamp_online_search_per_page`），`page` 下限 1；
/// - 过滤语义不变（`category`/`category_name` 大小写不敏感 + 隐藏规则）；
/// - `allowed_ids` 见 `paginate_with_allowed_ids`。
#[tauri::command(rename_all = "camelCase")]
pub fn get_category_apps(
    state: State<'_, AppState>,
    category: String,
    page: Option<u32>,
    per_page: Option<u32>,
    allowed_ids: Option<Vec<String>>,
) -> crate::AppResult<FeedPage> {
    let cat_clean = category.trim().to_lowercase();
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(&state)?;

    let filtered: Vec<AppSummary> = state.catalog.merged_summaries_filtered(|item| {
        crate::github::catalog_service::category_matches(item, &cat_clean)
            && !hidden_ids.contains(&item.id)
    });

    let (offset, limit) =
        category_page_window(&crate::config::get_project_config().limits, page, per_page);
    Ok(paginate_with_allowed_ids(
        filtered,
        allowed_ids.as_deref(),
        limit,
        offset,
    ))
}

/// 最新入库应用分页（与发现页/类别页 `FeedPage` 同形 `{items,total,has_more}`，含本地收录合并视图）：
/// - `since_days`: 相对天数窗口别名（等价于 `max_days` 且 `min_days=0`）；
/// - `min_days` / `max_days`: 相对天数区间（如 0~7, 7~30, 30~90），支持分段排他防头部霸榜；
/// - 排序规则：`added_at DESC`（无日期垫底）→ `stars DESC`（并列保质）→ `id ASC`（确定性破平）；
/// - `page`/`per_page` 均为 None=默认（第 1 页 20 条，与发现页、分类页对齐）；
/// - `allowed_ids` 见 `paginate_with_allowed_ids`；
/// - 纯内存执行，零网络秒开。
#[tauri::command(rename_all = "camelCase")]
pub fn get_latest_catalog_apps(
    state: State<'_, AppState>,
    since_days: Option<u32>,
    min_days: Option<u32>,
    max_days: Option<u32>,
    page: Option<u32>,
    per_page: Option<u32>,
    allowed_ids: Option<Vec<String>>,
) -> crate::AppResult<FeedPage> {
    let hidden_ids: std::collections::HashSet<String> =
        super::catalog_search::hidden_rule_ids(&state)?;
    let effective_max = max_days.or(since_days);
    let in_window: Vec<AppSummary> = state.catalog.merged_summaries_filtered(|item| {
        !hidden_ids.contains(&item.id)
            && in_latest_window(item.added_at.as_deref(), min_days, effective_max)
    });
    let ranked = sort_latest_apps(in_window);
    let (offset, limit) =
        category_page_window(&crate::config::get_project_config().limits, page, per_page);
    Ok(paginate_with_allowed_ids(
        ranked,
        allowed_ids.as_deref(),
        limit,
        offset,
    ))
}

/// 按平台允许集预过滤后分页（分类页/最新入库页共用）：
/// - `matched` 为分类/时间窗内全部非隐藏项（已排好序），其 ID 原样作为 `matched_ids` 回传，
///   供前端计算全平台分布并区分「本身为空」与「平台筛选为空」；
/// - `allowed_ids=None` 不过滤；`Some(ids)` 仅保留 ID（小写 trim 比较）在集合内的项，
///   空集合表示平台全不选，结果为空页；`total`/`has_more` 按过滤后计算。
pub fn paginate_with_allowed_ids(
    matched: Vec<AppSummary>,
    allowed_ids: Option<&[String]>,
    limit: usize,
    offset: usize,
) -> FeedPage {
    let matched_ids: Vec<String> = matched.iter().map(|a| a.core.id.clone()).collect();
    let filtered = filter_by_allowed_ids(matched, allowed_ids);
    let (items, total, has_more) =
        crate::github::catalog_feed_score::paginate_feed(&filtered, limit, offset);
    FeedPage {
        items,
        total,
        has_more,
        matched_ids: Some(matched_ids),
    }
}

/// `None` 原样返回；`Some(ids)` 保留 ID 在允许集（小写 trim、跳过空串）内的项并保持原序。
fn filter_by_allowed_ids(
    items: Vec<AppSummary>,
    allowed_ids: Option<&[String]>,
) -> Vec<AppSummary> {
    let Some(ids) = allowed_ids else {
        return items;
    };
    let allowed: std::collections::HashSet<String> = ids
        .iter()
        .map(|id| id.trim().to_lowercase())
        .filter(|id| !id.is_empty())
        .collect();
    items
        .into_iter()
        .filter(|a| allowed.contains(&a.core.id.to_lowercase()))
        .collect()
}

/// 纯函数：最新入库应用的筛选与倒排逻辑（便于单元测试与确定性回归）：
/// 1. 若指定 `min_days` 或 `max_days`，过滤掉不在当前天数区间内的项；
/// 2. 主序 `added_at DESC`，缺省者排在末尾；
/// 3. 次序 `stars DESC`；
/// 4. 破平 `id ASC`。
pub fn rank_and_filter_latest_apps(
    mut apps: Vec<AppSummary>,
    min_days: Option<u32>,
    max_days: Option<u32>,
) -> Vec<AppSummary> {
    apps.retain(|a| in_latest_window(a.core.added_at.as_deref(), min_days, max_days));
    sort_latest_apps(apps)
}

/// 最新入库时间窗判定：`max_days=None` 不限窗口；否则须有 `added_at` 且落在
/// `[min_days(缺省 0), max_days]` 天前区间内。
fn in_latest_window(added_at: Option<&str>, min_days: Option<u32>, max_days: Option<u32>) -> bool {
    let Some(max_d) = max_days else {
        return true;
    };
    let min_d = min_days.unwrap_or(0);
    added_at
        .map(|d| crate::date_utils::is_within_day_range(d, min_d, max_d))
        .unwrap_or(false)
}

/// 最新入库排序：`added_at DESC`（无日期垫底）→ `stars DESC` → `id ASC`。
fn sort_latest_apps(mut apps: Vec<AppSummary>) -> Vec<AppSummary> {
    apps.sort_by(|a, b| {
        // 1. added_at DESC (Some before None)
        match (&a.core.added_at, &b.core.added_at) {
            (Some(ad), Some(bd)) => {
                let ord = bd.cmp(ad);
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            (None, None) => {}
        }
        // 2. stars DESC
        let ord = b.core.stars.cmp(&a.core.stars);
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
        // 3. id ASC
        a.core.id.cmp(&b.core.id)
    });
    apps
}

/// 类别页分页窗口归一（纯函数，可单测）：`page` 下限 1，
/// `per_page` 复用搜索钳制；返回 `(offset, limit)`。
fn category_page_window(
    limits: &crate::config::LimitsConfig,
    page: Option<u32>,
    per_page: Option<u32>,
) -> (usize, usize) {
    let limit = limits.clamp_online_search_per_page(per_page);
    let eff_page = crate::config::LimitsConfig::normalize_online_search_page(page);
    (
        (eff_page as usize).saturating_sub(1).saturating_mul(limit),
        limit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::models::CatalogItem;

    #[test]
    fn category_dismissal_with_app_id_records_category_and_card() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let now = 1_800_000_000i64;
        record_featured_dismissal(&db, "media", "category", Some("Acme/Player"), now).unwrap();
        let fb = db.get_active_feed_feedback(now).unwrap();
        assert!(fb
            .iter()
            .any(|f| f.target == "media" && f.scope == crate::db::FeedbackScope::Category));
        assert!(fb
            .iter()
            .any(|f| f.target == "acme/player" && f.scope == crate::db::FeedbackScope::App));

        db.clear_feed_feedback().unwrap();
        record_featured_dismissal(&db, "games", "category", Some("  "), now).unwrap();
        let fb = db.get_active_feed_feedback(now).unwrap();
        assert_eq!(fb.len(), 1);
        assert!(record_featured_dismissal(&db, "games", "category", Some("bad"), now).is_err());
    }

    fn windowed(
        total: usize,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> (Vec<usize>, usize, bool) {
        let items: Vec<usize> = (0..total).collect();
        let (offset, limit) =
            category_page_window(&crate::config::LimitsConfig::default(), page, per_page);
        crate::github::catalog_feed_score::paginate_feed(&items, limit, offset)
    }

    #[test]
    fn category_first_page_defaults_to_20() {
        // 默认 None/None=第 1 页 20 条（与发现页/在线搜索对齐）。
        let (items, total, has_more) = windowed(52, None, None);
        assert_eq!(items.len(), 20);
        assert_eq!(items[0], 0);
        assert_eq!(total, 52);
        assert!(has_more);
    }

    #[test]
    fn category_second_page_appends_without_overlap() {
        // 第二页去重续接：[20..40)，仍有下一页。
        let (p1, _, _) = windowed(52, Some(1), None);
        let (p2, total, has_more) = windowed(52, Some(2), None);
        assert_eq!(p2.len(), 20);
        assert_eq!(p2[0], 20);
        assert!(p1.iter().all(|i| !p2.contains(i)));
        assert_eq!(total, 52);
        assert!(has_more);
    }

    #[test]
    fn category_last_page_clears_has_more() {
        // 52 条尾页 12 条且 has_more=false；越界页空且 false。
        let (last, total, has_more) = windowed(52, Some(3), None);
        assert_eq!(last.len(), 12);
        assert_eq!(total, 52);
        assert!(!has_more);
        let (over, _, over_more) = windowed(52, Some(99), None);
        assert!(over.is_empty());
        assert!(!over_more);
    }

    #[test]
    fn category_per_page_clamps_like_search() {
        // 钳制复用搜索同族：500→50，0→1。
        let (offset, limit) =
            category_page_window(&crate::config::LimitsConfig::default(), Some(1), Some(500));
        assert_eq!((offset, limit), (0, 50));
        let (offset, limit) =
            category_page_window(&crate::config::LimitsConfig::default(), Some(2), Some(0));
        assert_eq!((offset, limit), (1, 1));
    }

    fn feed_item(id: &str, owner: &str, repo: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            name: "Feed App".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            default_version: "v1.0.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: None,
            identifiers: std::collections::HashMap::new(),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: Vec::new(),
        }
    }

    #[test]
    fn feed_merge_includes_local_collected() {
        // 发现页合并含本地收录：远端 1 + 收录 1 = 2，远端优先去重，来源已盖章。
        let catalog =
            crate::github::CatalogService::with_items(vec![feed_item("o/remote", "o", "remote")]);
        // 空收录退化为纯远端。
        let remote_only = catalog.merged_summaries();
        assert_eq!(remote_only.len(), 1);
        assert_eq!(remote_only[0].core.source.as_deref(), Some("remote"));
        assert_eq!(remote_only[0].core.is_cataloged, Some(true));

        catalog.set_collected_items(vec![feed_item("o/local", "o", "local")]);
        let merged = catalog.merged_summaries();
        assert_eq!(merged.len(), 2);
        let local = merged
            .iter()
            .find(|s| s.core.id == "o/local")
            .expect("local row");
        assert_eq!(local.core.source.as_deref(), Some("local"));
        assert_eq!(local.core.status.as_deref(), Some("collected"));
        assert_eq!(local.core.is_cataloged, Some(true));
    }

    #[test]
    fn test_rank_and_filter_latest_apps_ordering() {
        let mut app1 = feed_item("o/app1", "o", "app1").to_summary();
        app1.core.added_at = Some("2026-09-10".to_string());
        app1.core.stars = 1000;

        let mut app2 = feed_item("o/app2", "o", "app2").to_summary();
        app2.core.added_at = Some("2026-10-16".to_string());
        app2.core.stars = 50;

        let mut app3 = feed_item("o/app3", "o", "app3").to_summary();
        app3.core.added_at = Some("2026-10-16".to_string());
        app3.core.stars = 200; // 同一天，Star 更高

        let mut app_nodate = feed_item("o/nodate", "o", "nodate").to_summary();
        app_nodate.core.added_at = None;
        app_nodate.core.stars = 99999;

        let list = vec![app1, app2, app3, app_nodate];
        let ranked = rank_and_filter_latest_apps(list, None, None);

        // 预期顺序: app3 (2026-10-16, 200) -> app2 (2026-10-16, 50) -> app1 (2026-09-10, 1000) -> app_nodate (None)
        assert_eq!(ranked[0].core.id, "o/app3");
        assert_eq!(ranked[1].core.id, "o/app2");
        assert_eq!(ranked[2].core.id, "o/app1");
        assert_eq!(ranked[3].core.id, "o/nodate");
    }

    #[test]
    fn test_rank_and_filter_latest_apps_since_days() {
        let today_days = crate::date_utils::today_days();
        let today_str = crate::date_utils::format_epoch_secs_ymd(today_days * 86400);
        let five_days_ago_str = crate::date_utils::format_epoch_secs_ymd((today_days - 5) * 86400);
        let twenty_days_ago_str =
            crate::date_utils::format_epoch_secs_ymd((today_days - 20) * 86400);

        let mut app_today = feed_item("o/today", "o", "today").to_summary();
        app_today.core.added_at = Some(today_str);

        let mut app_5d = feed_item("o/5d", "o", "5d").to_summary();
        app_5d.core.added_at = Some(five_days_ago_str);

        let mut app_20d = feed_item("o/20d", "o", "20d").to_summary();
        app_20d.core.added_at = Some(twenty_days_ago_str);

        let list = vec![app_today, app_5d, app_20d];

        // 7天窗口 (0~7)：包含 today 和 5d，排除 20d
        let filtered_7d = rank_and_filter_latest_apps(list.clone(), Some(0), Some(7));
        assert_eq!(filtered_7d.len(), 2);
        assert_eq!(filtered_7d[0].core.id, "o/today");
        assert_eq!(filtered_7d[1].core.id, "o/5d");

        // 30天窗口 (7~30)：排除 today 和 5d，仅包含 20d
        let filtered_30d = rank_and_filter_latest_apps(list.clone(), Some(7), Some(30));
        assert_eq!(filtered_30d.len(), 1);
        assert_eq!(filtered_30d[0].core.id, "o/20d");

        // 单入参窗口 `since_days` (None, Some(30))：包含全部 3 款
        let filtered_compat = rank_and_filter_latest_apps(list, None, Some(30));
        assert_eq!(filtered_compat.len(), 3);
    }

    fn thirty_matched() -> Vec<AppSummary> {
        (0..30)
            .map(|i| {
                let id = format!("o/app{i:02}");
                feed_item(&id, "o", &format!("app{i:02}")).to_summary()
            })
            .collect()
    }

    #[test]
    fn allowed_ids_none_keeps_full_platform_paging() {
        let page = paginate_with_allowed_ids(thirty_matched(), None, 20, 0);
        assert_eq!(page.items.len(), 20);
        assert_eq!(page.total, 30);
        assert!(page.has_more);
        assert_eq!(page.matched_ids.as_ref().map(Vec::len), Some(page.total));
    }

    #[test]
    fn allowed_ids_prefilter_fills_first_page_and_keeps_matched_ids() {
        // 5 条命中散落在原第 1~2 页（含大小写与空白差异）。
        let allowed: Vec<String> = ["o/app01", "O/APP07", " o/app19 ", "o/app22", "o/app29", ""]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let page = paginate_with_allowed_ids(thirty_matched(), Some(&allowed), 20, 0);
        let ids: Vec<&str> = page.items.iter().map(|a| a.core.id.as_str()).collect();
        assert_eq!(ids, ["o/app01", "o/app07", "o/app19", "o/app22", "o/app29"]);
        assert_eq!(page.total, 5);
        assert!(!page.has_more);
        let matched = page.matched_ids.expect("matched_ids");
        assert_eq!(matched.len(), 30);
        assert_eq!(matched[0], "o/app00");
    }

    #[test]
    fn allowed_ids_empty_selection_yields_empty_page() {
        let page = paginate_with_allowed_ids(thirty_matched(), Some(&[]), 20, 0);
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
        assert!(!page.has_more);
        assert_eq!(page.matched_ids.map(|m| m.len()), Some(30));
    }

    #[test]
    fn test_affinity_profile_summary_and_clear_account_signals() {
        let db = crate::db::Database::open_in_memory().expect("open in memory db");
        let mut sec_item = feed_item("bitwarden/clients", "bitwarden", "clients");
        sec_item.category = "security".to_string();
        sec_item.stars = 12000;
        sec_item.forks = 1500;
        let catalog = vec![sec_item];

        db.upsert_user_repo_signals(&[
            crate::db::UserRepoSignal {
                full_name: "bitwarden/clients".to_string(),
                relation: "starred".to_string(),
                language: "TypeScript".to_string(),
                description: "Password manager".to_string(),
                stars: 12000,
                forks: 1500,
                updated_at: 1_700_000_000,
            },
            crate::db::UserRepoSignal {
                full_name: "alice/clients".to_string(),
                relation: "forked".to_string(),
                language: "Rust".to_string(),
                description: "Forked client".to_string(),
                stars: 5,
                forks: 1,
                updated_at: 1_700_000_100,
            },
            crate::db::UserRepoSignal {
                full_name: "alice/my-tool".to_string(),
                relation: "owned".to_string(),
                language: "Rust".to_string(),
                description: "CLI utility".to_string(),
                stars: 20,
                forks: 2,
                updated_at: 1_700_000_200,
            },
        ])
        .unwrap();
        db.set_starred("ObsidianMD", "obsidian-releases", true)
            .unwrap();
        db.toggle_favorite("bitwarden/clients", true).unwrap();
        db.watch_app("bitwarden/clients", true).unwrap();
        db.set_setting(
            crate::github::affinity::SETTING_AFFINITY_GITHUB_SYNCED_AT,
            "1700000500",
        )
        .unwrap();

        let catalog_svc = crate::github::CatalogService::with_items(catalog);
        let summary = build_affinity_profile_summary(&db, &catalog_svc, 1_700_001_000).unwrap();
        assert!(summary.enabled);
        assert!(summary.local_enabled && summary.github_enabled);
        assert_eq!(summary.starred_repo_count, 2);
        assert_eq!(summary.forked_repo_count, 1);
        assert_eq!(summary.owned_repo_count, 1);
        assert_eq!(summary.favorites_count, 1);
        assert_eq!(summary.watched_count, 1);
        assert_eq!(summary.last_synced_at, Some(1_700_000_500));
        assert!(!summary.top_categories.is_empty());
        assert_eq!(summary.top_categories[0].category, "security");
        assert_eq!(summary.top_languages[0], "Rust");

        // 关闭 GitHub 用户信息：计数照常展示，偏好语言清空，个性化仍由本地应用信息维持
        db.set_setting(
            crate::github::affinity::SETTING_ENABLE_GITHUB_AFFINITY,
            "false",
        )
        .unwrap();
        let local_only = build_affinity_profile_summary(&db, &catalog_svc, 1_700_001_000).unwrap();
        assert!(local_only.enabled && local_only.local_enabled && !local_only.github_enabled);
        assert_eq!(local_only.starred_repo_count, 2);
        assert!(local_only.top_languages.is_empty());
        assert_eq!(local_only.top_categories[0].category, "security");

        // 两个信号源都关闭即回到编辑精选
        db.set_setting(
            crate::github::affinity::SETTING_ENABLE_LOCAL_AFFINITY,
            "false",
        )
        .unwrap();
        let none = build_affinity_profile_summary(&db, &catalog_svc, 1_700_001_000).unwrap();
        assert!(!none.enabled);
        assert!(none.top_categories.is_empty());
        db.remove_setting(crate::github::affinity::SETTING_ENABLE_LOCAL_AFFINITY)
            .unwrap();
        db.remove_setting(crate::github::affinity::SETTING_ENABLE_GITHUB_AFFINITY)
            .unwrap();

        // 清空 GitHub 账号信号：仓库特征信号、user_stars 与同步时间戳归零，本地收藏与 Watch 保留
        db.clear_github_account_signals().unwrap();
        let after_clear = build_affinity_profile_summary(&db, &catalog_svc, 1_700_001_000).unwrap();
        assert_eq!(after_clear.starred_repo_count, 0);
        assert_eq!(after_clear.forked_repo_count, 0);
        assert_eq!(after_clear.owned_repo_count, 0);
        assert_eq!(after_clear.last_synced_at, None);
        assert_eq!(after_clear.favorites_count, 1);
        assert_eq!(after_clear.watched_count, 1);
    }
}
