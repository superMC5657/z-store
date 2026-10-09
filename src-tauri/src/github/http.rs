//! GitHub 内本地 HTTP/日志/兜底 helpers（H1/H2/H3/H8/H10 收敛点）。
//!
//! 仅 `github` 模块内使用，跨 crate 统一留给二阶段，行为与原样板一致。

use crate::models::AppSummary;
use reqwest::header::{HeaderMap, HeaderValue, IF_NONE_MATCH};

#[derive(Debug, Clone)]
pub(crate) enum EtagGetOutcome {
    Fresh { text: String, etag: Option<String> },
    NotModified,
    Unauthorized,
    Failed,
}

/// 通用 ETag GET 请求通道：挂载 `If-None-Match`，处理 304 / 401 / 200 结果并上报限流。
pub(crate) async fn get_with_etag(
    client: &reqwest::Client,
    canonical_url: &str,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    cached_etag: Option<&str>,
    log_tag: &str,
) -> EtagGetOutcome {
    let url = crate::github::CatalogService::request_url(canonical_url, api_base);
    let mut headers = base_headers.clone();
    if let Some(etag) = cached_etag {
        if !etag.trim().is_empty() {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }
    }
    let safe_url = crate::log_support::sanitize_url(&url);
    let (req_id, sid) = new_log_ctx();
    let host = crate::log_support::host_of(&url);
    log::debug!(
        "http get dev etag tag={} sid={} req={} url='{}'",
        log_tag,
        sid,
        req_id,
        safe_url
    );
    let start = std::time::Instant::now();
    // 有限重试：仅传输错误(is_timeout/is_connect)+429/5xx，最多 2 次，
    // 退避 200ms -> 800ms；401/404/304 直接返回；限流上报逻辑不变（每轮响应照常上报）。
    const RETRY_BACKOFF_MS: [u64; 2] = [200, 800];
    let mut attempt: usize = 0;
    let res = loop {
        match client.get(&url).headers(headers.clone()).send().await {
            Ok(r) => {
                crate::notify_rate_limit("github.com", r.headers());
                let status = r.status();
                let retryable_status =
                    status.as_u16() == 429 || status.is_server_error();
                if retryable_status && attempt < RETRY_BACKOFF_MS.len() {
                    log::debug!(
                        "http get dev etag retry tag={} sid={} req={} url='{}' status={} attempt={} next_backoff_ms={}",
                        log_tag,
                        sid,
                        req_id,
                        safe_url,
                        status.as_u16(),
                        attempt + 1,
                        RETRY_BACKOFF_MS[attempt]
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RETRY_BACKOFF_MS[attempt],
                    ))
                    .await;
                    attempt += 1;
                    continue;
                }
                break r;
            }
            Err(e) => {
                let retryable_err = e.is_timeout() || e.is_connect();
                if retryable_err && attempt < RETRY_BACKOFF_MS.len() {
                    log::debug!(
                        "http get dev etag retry tag={} sid={} req={} host={} reason={} attempt={} next_backoff_ms={}",
                        log_tag,
                        sid,
                        req_id,
                        host,
                        crate::log_support::short_reason(&e.to_string()),
                        attempt + 1,
                        RETRY_BACKOFF_MS[attempt]
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        RETRY_BACKOFF_MS[attempt],
                    ))
                    .await;
                    attempt += 1;
                    continue;
                }
                log::warn!(
                    "http get dev etag failed tag={} sid={} req={} host={} reason={} elapsed_ms={}",
                    log_tag,
                    sid,
                    req_id,
                    host,
                    crate::log_support::short_reason(&e.to_string()),
                    start.elapsed().as_millis()
                );
                return EtagGetOutcome::Failed;
            }
        }
    };
    let status = res.status();
    log::debug!(
        "http resp dev etag tag={} sid={} req={} url='{}' status={} elapsed_ms={}",
        log_tag,
        sid,
        req_id,
        safe_url,
        status.as_u16(),
        start.elapsed().as_millis()
    );
    log::info!(
        "http resp dev etag tag={} sid={} req={} host={} status={} elapsed_ms={}",
        log_tag,
        sid,
        req_id,
        host,
        status.as_u16(),
        start.elapsed().as_millis()
    );
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return EtagGetOutcome::NotModified;
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return EtagGetOutcome::Unauthorized;
    }
    if !status.is_success() {
        return EtagGetOutcome::Failed;
    }
    let etag = res
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    match res.text().await {
        Ok(text) => EtagGetOutcome::Fresh { text, etag },
        Err(e) => {
            log::warn!(
                "http read dev etag body failed tag={} sid={} req={} host={} reason={}",
                log_tag,
                sid,
                req_id,
                host,
                crate::log_support::short_reason(&e.to_string())
            );
            EtagGetOutcome::Failed
        }
    }
}

/// UA 常量统一收敛到 `forge::http` SSOT（第一步：常量统一，值与旧字面量一致）。
/// `GH_ACCEPT` 已由 `ApiPreset::GithubApi` 表驱动收敛，不再保留字面量别名，避免双源漂移。
pub(crate) const GH_USER_AGENT: &str = crate::forge::http::USER_AGENT_VALUE;

/// H8：github 内统一秒级时间戳（与 `db::now_secs` 同语义，跨 crate 统一留给二阶段）。
pub(crate) fn now_secs() -> i64 {
    crate::now_secs()
}

/// H2：统一 API 超时（读取项目配置）。
pub(crate) fn api_timeout() -> std::time::Duration {
    std::time::Duration::from_secs(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    )
}

/// H2：统一 API 客户端构造（timeout 语义不变，委托 `forge::http` SSOT）。
pub(crate) fn build_api_client() -> Result<reqwest::Client, String> {
    crate::forge::http::new_api_client(api_timeout().as_secs())
}

/// H1：`token {}` 方案（含 ACCEPT），镜像 `detail`/`search` 旧行为。
/// 薄包装：保留旧名与签名，函数体委托 `forge::http` 表驱动预设（`Token` 小写前缀不可合错）。
pub(crate) fn token_headers(token: Option<&str>) -> HeaderMap {
    crate::forge::http::preset_headers(
        crate::forge::http::ApiPreset::GithubApi,
        token,
        crate::forge::http::AuthScheme::Token,
    )
}

/// H1：`Bearer {}` 方案（含 ACCEPT），镜像 `developer_*` 旧行为。
/// 薄包装：保留旧名与签名，函数体委托 `forge::http` 表驱动预设。
pub(crate) fn bearer_headers(token: Option<&str>) -> HeaderMap {
    crate::forge::http::preset_headers(
        crate::forge::http::ApiPreset::GithubApi,
        token,
        crate::forge::http::AuthScheme::Bearer,
    )
}

/// H3：统一日志上下文，返回 `(req_id, sid)`，顺序与原样板一致。
pub(crate) fn new_log_ctx() -> (String, String) {
    (crate::z_log::new_req_id(), crate::z_log::new_session_id())
}

/// H10：兜底平台列表（已废弃：未知仓库返回空，由前端 virtual-Other 规则接管）。
/// 保留空实现仅防外部误用；"other" 永不过 IPC、永不进入 installer 匹配。
#[allow(dead_code)]
#[deprecated(note = "unknown repos return []; frontend virtual-Other takes over")]
pub(crate) fn fallback_platforms() -> Vec<String> {
    Vec::new()
}

/// H10：分类元信息结构体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CategoryMeta {
    pub key: &'static str,
    pub name: &'static str,
    pub gradient: &'static str,
}

/// 移植 catalog guessCategory 关键词表（system/network/media/security/dev/graphics/office/reading/ops/games）。
/// 依据 description（含中文与英文）及 GitHub topics 标签推断最贴切的分类。
pub(crate) fn guess_category(
    desc: Option<&str>,
    desc_en: Option<&str>,
    topics: &[String],
) -> CategoryMeta {
    let mut text = String::new();
    if let Some(d) = desc {
        text.push_str(d);
        text.push(' ');
    }
    if let Some(d) = desc_en {
        text.push_str(d);
        text.push(' ');
    }
    for topic in topics {
        text.push_str(topic);
        text.push(' ');
    }
    let text = text.to_lowercase();

    if text.contains("remote")
        || text.contains("desktop")
        || text.contains("cleaner")
        || text.contains("launcher")
        || text.contains("file manager")
    {
        return CategoryMeta {
            key: "system",
            name: "系统实用",
            gradient: "linear-gradient(135deg, #475569, #334155)",
        };
    }
    if text.contains("network")
        || text.contains("transfer")
        || text.contains("download")
        || text.contains("torrent")
        || text.contains("proxy")
        || text.contains("vpn")
    {
        return CategoryMeta {
            key: "network",
            name: "网络工具",
            gradient: "linear-gradient(135deg, #0284c7, #0369a1)",
        };
    }
    if text.contains("player")
        || text.contains("video")
        || text.contains("audio")
        || text.contains("music")
        || text.contains("stream")
        || text.contains("record")
    {
        return CategoryMeta {
            key: "media",
            name: "影音视听",
            gradient: "linear-gradient(135deg, #ec4899, #be185d)",
        };
    }
    if text.contains("password")
        || text.contains("security")
        || text.contains("crypto")
        || text.contains("2fa")
        || text.contains("otp")
        || text.contains("authenticator")
    {
        return CategoryMeta {
            key: "security",
            name: "安全隐私",
            gradient: "linear-gradient(135deg, #059669, #047857)",
        };
    }
    if text.contains("editor")
        || text.contains("terminal")
        || text.contains("git")
        || text.contains("code")
        || text.contains("developer")
        || text.contains("api")
    {
        return CategoryMeta {
            key: "dev",
            name: "开发工具",
            gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
        };
    }
    if text.contains("image")
        || text.contains("paint")
        || text.contains("photo")
        || text.contains("screenshot")
        || text.contains("3d")
        || text.contains("svg")
    {
        return CategoryMeta {
            key: "graphics",
            name: "图形设计",
            gradient: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
        };
    }
    if text.contains("note")
        || text.contains("markdown")
        || text.contains("pdf")
        || text.contains("office")
        || text.contains("todo")
        || text.contains("calendar")
    {
        return CategoryMeta {
            key: "office",
            name: "效率办公",
            gradient: "linear-gradient(135deg, #d97706, #b45309)",
        };
    }
    if text.contains("book")
        || text.contains("reader")
        || text.contains("rss")
        || text.contains("epub")
        || text.contains("feed")
    {
        return CategoryMeta {
            key: "reading",
            name: "学习阅读",
            gradient: "linear-gradient(135deg, #0d9488, #0f766e)",
        };
    }
    if text.contains("docker")
        || text.contains("kubernetes")
        || text.contains("monitor")
        || text.contains("database")
        || text.contains("server")
    {
        return CategoryMeta {
            key: "ops",
            name: "极客运维",
            gradient: "linear-gradient(135deg, #4f46e5, #3730a3)",
        };
    }
    if text.contains("game") || text.contains("emulator") || text.contains("arcade") {
        return CategoryMeta {
            key: "games",
            name: "休闲游戏",
            gradient: "linear-gradient(135deg, #e11d48, #be123c)",
        };
    }

    CategoryMeta {
        key: "dev",
        name: "开发工具",
        gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    }
}

pub(crate) fn is_avatar_icon_url(url: &str) -> bool {
    let u = url.trim();
    crate::commands::is_avatar_url(u)
        || (u.starts_with("https://github.com/") && u.ends_with(".png") && !u.contains("/raw/"))
        || u.contains("github.com/identicons/")
}

/// 若 app_icon_cycles 有该 app 且 selected_url 非空，
/// 则返回已确认的图标（本地缓存文件有效时优先返回 dataURI 语义，
/// 缓存缺失/不可读时回退到可用 remote_url；后台补探只写 selected_url 不写 cache_file，
/// 此处不再因 cache_file 为空而返回 None，否则重复搜索首屏恒为 ''），否则返回 None。
/// M2=落盘已确认
/// B3-G11 SSOT：标识解析经 `RepositoryUrlParser` + `canonical_app_id`，大小写回退收进
/// `forge::coord::lookup_case_insensitive`（db 查询侧），此处不再手写 `to_lowercase` 多段回退。
pub(crate) fn resolve_confirmed_icon_from_db(
    db: &crate::db::Database,
    app_id: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let repo_ref = crate::forge::coord::RepoRef::new(owner, repo);
    let cycle = crate::forge::coord::lookup_case_insensitive(db, app_id, &repo_ref)?;

    let selected = cycle.selected_url.trim();
    if selected.is_empty() || is_avatar_icon_url(selected) {
        return None;
    }

    let cache_file = cycle.cache_file.trim();
    if !cache_file.is_empty() {
        let icons_dir = crate::get_app_data_dir().join("icons");
        let cache_path = icons_dir.join(cache_file);
        if let Ok(bytes) = std::fs::read(&cache_path) {
            if !bytes.is_empty() && crate::commands::is_valid_image(&bytes) {
                return Some(crate::commands::bytes_to_data_uri(&bytes));
            }
        }
    }

    Some(selected.to_string())
}

/// 尝试从本地默认数据库解析已确认的图标。
/// Top1 fallback 保留：仅当调用方传不进 `&Database`（`None`）且 `probe=true` 时回退本地直连，
/// `ok()` 吞错不 panic；搜索首屏 `probe=false` 传 `None` 时直接置空，零直连。
pub(crate) fn open_db_opt() -> Option<crate::db::Database> {
    let db_path = crate::get_app_data_dir().join("z_store.db");
    if db_path.is_file() {
        crate::db::Database::open(&db_path).ok()
    } else {
        None
    }
}

/// H10：目录外仓库 `AppSummary` 兜底构造。
/// 图标：若 probe 为 true，先快后慢——快路径 SimpleIcons（图标L2=品牌库；免鉴权，repo+owner 去重单循环，
/// 每 slug ≤1500ms，命中即返），慢路径 Trees（图标L3=仓库；有 token 才跑，保持 12s）；绝不调 users API、不拼 avatar_url；
/// 若 probe 为 false，图标置空（首屏快返，等后台补探 emit）。
/// 分类：移植 catalog guessCategory 关键词表，按 topics+description 判定。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fallback_summary(
    client: &reqwest::Client,
    id: String,
    name: String,
    owner: String,
    repo: String,
    description: String,
    description_en: Option<String>,
    stars: u64,
    forks: u64,
    license: String,
    topics: &[String],
    homepage: Option<String>,
    probe: bool,
    confirmed_icon: Option<String>,
    token: Option<&str>,
) -> AppSummary {
    let cat = guess_category(Some(&description), description_en.as_deref(), topics);
    // Top1 灭 N+1：`probe=false` 搜索首屏直接置空零直连（确认图标由调用方 `state.db()` 单锁批量 enrich 回填）；
    // `probe=true` 单仓直查才回退本地直连（`ok()` 吞错不 panic，单条非 N+1，`Send` 安全因直连为 owned 短命）。
    let confirmed = match confirmed_icon {
        Some(ci) => Some(ci),
        None => {
            if probe {
                open_db_opt().and_then(|odb| {
                    resolve_confirmed_icon_from_db(&odb, &id, &owner, &repo)
                })
            } else {
                None
            }
        }
    };
    let icon = if let Some(ci) = confirmed {
        ci
    } else if probe {
        // 先快后慢：快路径无 token 也可跑，慢路径有 token 才跑。
        if let Some(hit) =
            crate::github::icon_probe::probe_simple_icons(client, &owner, &repo).await
        {
            hit.url
        } else if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
            let hdrs = token_headers(Some(tok));
            crate::github::icon_probe::probe_trees(client, &hdrs, &owner, &repo, "main")
                .await
                .map(|h| h.url)
                .unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    AppSummary {
        id,
        name,
        description_en,
        owner,
        repo,
        icon,
        icon_bg: cat.gradient.to_string(),
        description,
        stars,
        forks,
        license,
        latest_version: "latest".to_string(),
        category: cat.key.to_string(),
        category_name: cat.name.to_string(),
        is_verified: false,
        is_installed: None,
        has_update: None,
        installed_version: None,
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        homepage,
        platforms: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_guess_category_all_10_kinds() {
        assert_eq!(guess_category(Some("A remote desktop client"), None, &[]).key, "system");
        assert_eq!(guess_category(Some("High performance proxy and vpn"), None, &[]).key, "network");
        assert_eq!(guess_category(Some("Music and video stream player"), None, &[]).key, "media");
        assert_eq!(guess_category(Some("Password manager and 2fa authenticator"), None, &[]).key, "security");
        assert_eq!(guess_category(Some("Code editor and terminal"), None, &[]).key, "dev");
        assert_eq!(guess_category(Some("3D image paint and photo screenshot"), None, &[]).key, "graphics");
        assert_eq!(guess_category(Some("Markdown note and pdf office tool"), None, &[]).key, "office");
        assert_eq!(guess_category(Some("RSS feed reader and book library"), None, &[]).key, "reading");
        assert_eq!(guess_category(Some("Docker container and kubernetes server"), None, &[]).key, "ops");
        assert_eq!(guess_category(Some("Retro arcade game emulator"), None, &[]).key, "games");
    }

    #[test]
    fn test_guess_category_fallback_to_dev() {
        assert_eq!(guess_category(Some("Unmatched generic project"), None, &[]).key, "dev");
        assert_eq!(guess_category(None, None, &[]).key, "dev");
    }

    #[test]
    fn test_guess_category_via_topics() {
        assert_eq!(guess_category(None, None, &["proxy".to_string(), "vpn".to_string()]).key, "network");
        assert_eq!(guess_category(None, None, &["emulator".to_string()]).key, "games");
    }

    #[tokio::test]
    async fn test_resolve_confirmed_icon_from_db_scenarios() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let app_id = "testowner/testrepo";
        let owner = "testowner";
        let repo = "testrepo";

        // 1. 无记录：返回 None
        assert_eq!(resolve_confirmed_icon_from_db(&db, app_id, owner, repo), None);

        // 2. 有记录但 selected_url 为空（Level 5）
        let empty_cycle = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            level: 5,
            selected_url: String::new(),
            cache_file: String::new(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&empty_cycle).unwrap();
        assert_eq!(resolve_confirmed_icon_from_db(&db, app_id, owner, repo), None);

        // 3. 有记录且 selected_url 非空，但 cache_file 在磁盘上不存在：
        //    回退 remote_url（后台补探只写 selected_url，重复搜索首屏不再恒为 ''）。
        let cycle_missing_file = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            level: 1,
            selected_url: "https://example.com/icon.png".to_string(),
            cache_file: "non_existent_file_12345.png".to_string(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle_missing_file).unwrap();
        assert_eq!(
            resolve_confirmed_icon_from_db(&db, app_id, owner, repo),
            Some("https://example.com/icon.png".to_string())
        );

        // 4. 有记录且 cache_file 存在并为有效图片：返回 dataURI
        let icons_dir = crate::get_app_data_dir().join("icons");
        let _ = std::fs::create_dir_all(&icons_dir);
        let test_filename = "testowner_testrepo_l1.png";
        let test_file_path = icons_dir.join(test_filename);
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4";
        std::fs::write(&test_file_path, png_bytes).unwrap();

        let cycle_valid = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            level: 1,
            selected_url: "https://example.com/icon.png".to_string(),
            cache_file: test_filename.to_string(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle_valid).unwrap();

        let resolved = resolve_confirmed_icon_from_db(&db, app_id, owner, repo);
        assert!(resolved.is_some());
        let uri = resolved.unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));

        // 5. 大小写容错支持（例如传入 TestOwner/TestRepo）
        let resolved_case = resolve_confirmed_icon_from_db(&db, "TestOwner/TestRepo", "TestOwner", "TestRepo");
        assert_eq!(resolved_case, Some(uri.clone()));

        // 6. 清理测试文件
        let _ = std::fs::remove_file(&test_file_path);
    }

    #[test]
    fn search_resolve_falls_back_to_selected_url() {
        // 回归：后台补探只写 selected_url（cache_file 为空）时，
        // 重复搜索首屏必须回退 remote_url 而非 None（不再恒为 ''）。
        let db = crate::db::Database::open_in_memory().unwrap();
        let app_id = "fallbackowner/fallbackrepo";
        let cycle = crate::db::AppIconCycle {
            app_id: app_id.to_string(),
            owner: "fallbackowner".to_string(),
            repo: "fallbackrepo".to_string(),
            level: 2,
            selected_url: "https://cdn.simpleicons.org/fallbackrepo".to_string(),
            cache_file: String::new(),
            ..Default::default()
        };
        db.upsert_icon_cycle(&cycle).unwrap();
        assert_eq!(
            resolve_confirmed_icon_from_db(&db, app_id, "fallbackowner", "fallbackrepo"),
            Some("https://cdn.simpleicons.org/fallbackrepo".to_string())
        );
    }

    #[tokio::test]
    async fn test_fallback_summary_confirmed_icon_semantics() {
        let client = reqwest::Client::new();

        // 当 confirmed_icon 为 None 且 probe 为 false 时，icon 必须置空
        let summary_none = fallback_summary(
            &client,
            "demo/app".to_string(),
            "app".to_string(),
            "demo".to_string(),
            "app".to_string(),
            "Demo description".to_string(),
            None,
            10,
            2,
            "MIT".to_string(),
            &[],
            None,
            false,
            None,
            None,
        )
        .await;
        assert_eq!(summary_none.icon, "");
        // 未知仓库不再兜底 ["windows"]：直接返回 []，由前端 virtual-Other 接管。
        assert!(summary_none.platforms.is_empty());

        // 当 confirmed_icon 存在时，无论是 probe=true 还是 probe=false 均优先使用 confirmed_icon
        let custom_uri = "data:image/png;base64,testdata";
        let summary_confirmed = fallback_summary(
            &client,
            "demo/app".to_string(),
            "app".to_string(),
            "demo".to_string(),
            "app".to_string(),
            "Demo description".to_string(),
            None,
            10,
            2,
            "MIT".to_string(),
            &[],
            None,
            false,
            Some(custom_uri.to_string()),
            None,
        )
        .await;
        assert_eq!(summary_confirmed.icon, custom_uri);
        // platforms 同样不再兜底 ["windows"]：未知仓库一律 []。
        assert!(summary_confirmed.platforms.is_empty());
    }

    #[tokio::test]
    async fn test_fallback_summary_platforms_empty_no_windows_stamp() {
        let client = reqwest::Client::new();
        let summary = fallback_summary(
            &client,
            "unknown/repo".to_string(),
            "repo".to_string(),
            "unknown".to_string(),
            "repo".to_string(),
            "Unknown repo".to_string(),
            None,
            0,
            0,
            "MIT".to_string(),
            &[],
            None,
            false,
            None,
            None,
        )
        .await;
        assert!(summary.platforms.is_empty());
        assert!(!summary.platforms.contains(&"windows".to_string()));
        assert!(!summary.platforms.contains(&"other".to_string()));
    }
}
