//! GitHub 内本地 HTTP/日志/兜底 helpers（H1/H2/H3/H8/H10 收敛点）。
//!
//! 仅 `github` 模块内使用，跨 crate 统一留给二阶段，行为与原样板一致。

use crate::models::AppSummary;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

pub(crate) const GH_USER_AGENT: &str = "ZStore-Client/0.1.0";
pub(crate) const GH_ACCEPT: &str = "application/vnd.github.v3+json";

/// H8：github 内统一秒级时间戳（与 `db::now_secs` 同语义，跨 crate 统一留给二阶段）。
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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

/// H10：兜底组织头像。
pub(crate) fn fallback_icon(owner: &str) -> String {
    format!("https://github.com/{}.png", owner)
}

/// H10：兜底平台列表。
pub(crate) fn fallback_platforms() -> Vec<String> {
    vec!["windows".to_string()]
}

/// H10：目录外仓库 `AppSummary` 兜底构造（`search` 两处回退共用，字段语义不变）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn fallback_summary(
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
        icon: fallback_icon(&owner),
        icon_bg: icon_bg.to_string(),
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
