//! GitHub 内本地 HTTP/日志/兜底 helpers（H1/H2/H3/H8/H10 收敛点）。
//!
//! 仅 `github` 模块内使用，跨 crate 统一留给二阶段，行为与原样板一致。

use crate::models::AppSummary;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT};

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
    let res = match client.get(&url).headers(headers).send().await {
        Ok(r) => r,
        Err(e) => {
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
    };
    crate::notify_rate_limit("github.com", res.headers());
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

pub(crate) const GH_USER_AGENT: &str = "ZStore-Client/0.1.0";
pub(crate) const GH_ACCEPT: &str = "application/vnd.github.v3+json";

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

/// H2：统一 API 客户端构造（timeout 语义不变）。
pub(crate) fn build_api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(api_timeout())
        .build()
        .map_err(|e| e.to_string())
}

fn base_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(GH_USER_AGENT));
    headers.insert(ACCEPT, HeaderValue::from_static(GH_ACCEPT));
    headers
}

/// H1：`token {}` 方案（含 ACCEPT），镜像 `detail`/`search` 旧行为。
pub(crate) fn token_headers(token: Option<&str>) -> HeaderMap {
    let mut headers = base_headers();
    if let Some(tok) = token {
        if !tok.trim().is_empty() {
            if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                headers.insert(AUTHORIZATION, val);
            }
        }
    }
    headers
}

/// H1：`Bearer {}` 方案（含 ACCEPT），镜像 `developer_*` 旧行为。
pub(crate) fn bearer_headers(token: Option<&str>) -> HeaderMap {
    let mut headers = base_headers();
    if let Some(tok) = token {
        let t = tok.trim();
        if !t.is_empty() {
            if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", t)) {
                headers.insert(AUTHORIZATION, val);
            }
        }
    }
    headers
}

/// H3：统一日志上下文，返回 `(req_id, sid)`，顺序与原样板一致。
pub(crate) fn new_log_ctx() -> (String, String) {
    (crate::z_log::new_req_id(), crate::z_log::new_session_id())
}

/// H10：兜底平台列表。
pub(crate) fn fallback_platforms() -> Vec<String> {
    vec!["windows".to_string()]
}

/// H10：目录外仓库 `AppSummary` 兜底构造（`search` 两处回退共用，字段语义不变）。
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
    icon_bg: &str,
    category: &str,
    category_name: &str,
    homepage: Option<String>,
) -> AppSummary {
    AppSummary {
        id,
        name,
        description_en,
        owner: owner.clone(),
        repo,
        icon,
        icon_bg: cat.gradient.to_string(),
        description,
        stars,
        forks,
        license,
        latest_version: "latest".to_string(),
        category: category.to_string(),
        category_name: category_name.to_string(),
        is_verified: false,
        is_installed: None,
        has_update: None,
        installed_version: None,
        forge: Some("github".to_string()),
        forge_host: Some("github.com".to_string()),
        homepage,
        platforms: fallback_platforms(),
    }
}
    probe: bool,
    confirmed_icon: Option<String>,

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

        // 3. 有记录且 selected_url 非空，但 cache_file 在磁盘上不存在
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
        assert_eq!(resolve_confirmed_icon_from_db(&db, app_id, owner, repo), None);

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
        )
        .await;
        assert_eq!(summary_none.icon, "");

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
        )
        .await;
        assert_eq!(summary_confirmed.icon, custom_uri);
    }
}
    probe: bool,
    confirmed_icon: Option<String>,
