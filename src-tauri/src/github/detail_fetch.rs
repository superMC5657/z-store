use super::detail_assets::is_valid_installer_asset;
use crate::github::developer_profile::EtagGetOutcome;
use crate::github::models::{
    is_placeholder_description, CatalogItem, GitHubAssetResponse, GitHubRepoResponse,
};
use crate::github::CatalogService;
use crate::models::{AppCore, AppDetail, ReleaseAsset};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use std::collections::HashMap;

use crate::repositories::EtagWrite;

/// 预读的 ETag 条件请求缓存束（由调用方短锁预读传入，彻底消除底层 DB 直连）。
#[derive(Debug, Clone, Default)]
pub struct DetailEtagPrefetch {
    pub release_etag: Option<String>,
    pub release_payload: Option<String>,
    pub repo_etag: Option<String>,
    pub repo_payload: Option<String>,
    pub readme_etag: Option<String>,
    pub readme_payload: Option<String>,
}

/// 详情抓取输出：组装后的 `AppDetail` + 待落盘 ETag 列表 + 图标解析 + 诊断信息。
#[derive(Debug, Clone)]
pub struct DetailFetchOutput {
    pub detail: AppDetail,
    pub etag_writes: Vec<EtagWrite>,
    pub release_cache_written: bool,
    pub icon_resolution: Option<crate::icons::DetailIconResolution>,
    pub diag: DetailFetchDiag,
}

fn parse_repo_payload(payload: Option<&String>) -> Option<GitHubRepoResponse> {
    payload.and_then(|pl| serde_json::from_str::<GitHubRepoResponse>(pl).ok())
}

/// 从 SQLite ETag 缓存同步读取 repo 描述（不触网）；已收录仓库应由调用方优先保留人工精校描述。
pub(crate) fn repo_real_description_from_etag(
    db: &crate::db::Database,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let owner = owner.trim();
    let repo = repo.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let raw = crate::github::github_repo_endpoint(owner, repo);
    let lowered = crate::github::github_repo_endpoint(&owner.to_lowercase(), &repo.to_lowercase());
    let mut urls = vec![raw];
    if !urls.contains(&lowered) {
        urls.push(lowered);
    }
    for url in urls {
        let payload = match db.get_cached_payload(&url) {
            Ok(Some(p)) => p,
            _ => continue,
        };
        let desc_opt = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| {
                v.get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string())
            })
            .map(|s: String| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| !is_placeholder_description(s));
        if let Some(real) = desc_opt {
            return Some(real);
        }
    }
    None
}

/// 详情页内部解析的仓库基础信息与收录项。
struct DetailIdentity {
    owner: String,
    repo: String,
    name: String,
    desc: String,
    icon: String,
    icon_bg: String,
    catalog_item: Option<CatalogItem>,
}

/// 身份解析 seam：endpoints + 收录项一次取出（读锁一次）。
fn resolve_detail_identity(svc: &CatalogService, id: &str) -> Result<DetailIdentity, String> {
    let coords = svc.get_repo_coordinates(id)?;
    let catalog_item = svc.get_catalog_item(id);
    Ok(DetailIdentity {
        owner: coords.owner,
        repo: coords.repo,
        name: coords.name,
        desc: coords.description,
        icon: coords.icon,
        icon_bg: coords.icon_bg,
        catalog_item,
    })
}

/// 详情抓取子阶段诊断汇总（供上层宽事件单行输出，底层不直接刷屏）。
#[derive(Debug, Clone, Default)]
pub struct DetailFetchDiag {
    pub steps: Vec<String>,
    pub rate_summary: Option<String>,
    pub checksum_why: Option<String>,
    pub icon_source: Option<String>,
}

/// repo 抓取 seam：ETag 条件请求 + 限流上报 + 缓存回退解析（返回待写 ETag 与 `HttpDiag`）。
async fn fetch_repo_info(
    client: &reqwest::Client,
    api_base: Option<&str>,
    base_headers: &HeaderMap,
    repo_url: &str,
    repo_etag: Option<&str>,
    repo_payload: Option<String>,
    id: &str,
) -> (
    Option<GitHubRepoResponse>,
    Option<EtagWrite>,
    crate::log_support::HttpDiag,
) {
    let (outcome, diag) = crate::github::http::get_with_etag_diag(
        client,
        repo_url,
        api_base,
        base_headers,
        repo_etag,
    )
    .await;
    match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            let etag_write = etag.map(|et| EtagWrite {
                url: repo_url.to_string(),
                etag: et,
                payload: text.clone(),
                timestamp: crate::github::http::now_secs(),
            });
            (
                serde_json::from_str::<GitHubRepoResponse>(&text).ok(),
                etag_write,
                diag,
            )
        }
        other => {
            if matches!(other, EtagGetOutcome::Unauthorized) {
                crate::check_auth_expired(401, &format!("op=detail-repo id={}", id));
            }
            (parse_repo_payload(repo_payload.as_ref()), None, diag)
        }
    }
}

/// `304` 复用命中且远端 `/repos` 返回时刷新动态指标与回退元数据：
/// - `stars` / `forks` 以远端显式数值为准（含合法 `0`）；
/// - `license` 仅在解析值为具体协议，或缓存原协议为空/占位时更新，避免 `OpenSource` 覆盖缓存中的 `MIT` 等具体协议。
fn apply_304_repo_refresh(
    detail: &mut AppDetail,
    repo_info: &GitHubRepoResponse,
    catalog_item: Option<&CatalogItem>,
    owner: &str,
    repo: &str,
) {
    let DetailStats {
        stars,
        forks,
        license,
        homepage,
    } = resolve_detail_stats(Some(repo_info), catalog_item, owner, repo);
    if repo_info.stargazers_count.is_some() {
        detail.core.stars = stars;
    }
    if repo_info.forks_count.is_some() {
        detail.core.forks = forks;
    }
    if CatalogItem::is_concrete_license(&license)
        || !CatalogItem::is_concrete_license(&detail.core.license)
    {
        detail.core.license = license;
    }
    if homepage.is_some() {
        detail.core.homepage = homepage;
    }
    let (eff_desc, eff_en) = resolve_effective_descriptions(
        catalog_item,
        detail.core.description.clone(),
        Some(repo_info),
    );
    detail.core.description = eff_desc;
    if eff_en.is_some() {
        detail.core.description_en = eff_en;
    }
    if let Some(is_priv) = repo_info.private {
        detail.is_private = is_priv;
    }
}

/// 304 零开销复用 seam：release 未变 + 本地有完整缓存（releases 非空 + readme 非空）直接复用；
/// 经 `heal_cached_detail` 统一自愈（过滤无效资产、重算分类/平台并叠加收录库精校字段），时间戳收敛 now_secs。
fn reuse_304_cached(
    cached_detail: Option<&AppDetail>,
    catalog_item: Option<&CatalogItem>,
) -> Option<AppDetail> {
    let existing = cached_detail?;
    if existing.releases.is_empty() || existing.readme_markdown.trim().is_empty() {
        return None;
    }
    let mut detail = existing.clone();
    super::detail_assets::heal_cached_detail(&mut detail, catalog_item);
    detail.cached_at = Some(crate::github::http::now_secs());
    detail.is_stale = None;
    Some(detail)
}

/// readme 抓取输入束（多参数成束，避免长参数列在 join 点散开）。
struct ReadmeFetch<'a> {
    client: &'a reqwest::Client,
    api_base: Option<&'a str>,
    url: &'a str,
    headers: &'a HeaderMap,
    etag: Option<&'a str>,
    payload: Option<&'a String>,
    version_changed: bool,
    has_cached_readme: bool,
    cached_readme: Option<&'a String>,
    default_readme: &'a str,
    log_id: &'a str,
}

/// readme 抓取 seam：版本未变 + 有缓存直接复用；否则 ETag 条件请求，返回 `(markdown, etag_write, step_label)`。
async fn fetch_readme_markdown(req: ReadmeFetch<'_>) -> (String, Option<EtagWrite>, String) {
    if !req.version_changed && req.has_cached_readme {
        if let Some(r) = req.cached_readme {
            return (r.clone(), None, "readme:cached".to_string());
        }
    }
    let (outcome, diag) = crate::github::http::get_with_etag_diag(
        req.client,
        req.url,
        req.api_base,
        req.headers,
        req.etag,
    )
    .await;
    let step = diag.step_label("readme");
    let mut etag_write: Option<EtagWrite> = None;
    let text = match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            etag_write = etag.map(|et| EtagWrite {
                url: req.url.to_string(),
                etag: et,
                payload: text.clone(),
                timestamp: crate::github::http::now_secs(),
            });
            if text.is_empty() {
                req.default_readme.to_string()
            } else {
                text
            }
        }
        EtagGetOutcome::NotModified => {
            if let Some(pl) = req.payload {
                if pl.is_empty() {
                    req.default_readme.to_string()
                } else {
                    pl.clone()
                }
            } else if let Some(r) = req.cached_readme {
                r.clone()
            } else {
                req.default_readme.to_string()
            }
        }
        EtagGetOutcome::Unauthorized => {
            crate::check_auth_expired(401, &format!("op=detail-readme id={}", req.log_id));
            if let Some(r) = req.cached_readme {
                r.clone()
            } else {
                req.default_readme.to_string()
            }
        }
        EtagGetOutcome::Failed => {
            if let Some(r) = req.cached_readme {
                r.clone()
            } else {
                req.default_readme.to_string()
            }
        }
    };
    (text, etag_write, step)
}

/// icon 探测 seam：无 token 时仍跑免鉴权 L2 SimpleIcons（零 GitHub API 配额消耗）；
/// 有 token 时进完整 SimpleIcons+Trees（命中原样回传，source 日志由调用方记）。
async fn probe_repo_icon(
    api_client: &reqwest::Client,
    base_headers: &HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
    has_token: bool,
) -> Option<crate::icons::ProbedIcon> {
    let icon_client = crate::forge::http::new_icon_client(
        crate::config::get_project_config()
            .network
            .api_timeout_seconds,
    )
    .unwrap_or_default();
    if !has_token {
        return crate::icons::probe_l2_simple(&icon_client, owner, repo)
            .await
            .map(|url| crate::icons::ProbedIcon {
                url,
                source: "simple-icons",
            });
    }
    crate::icons::probe_repo_logo(
        &icon_client,
        api_client,
        Some(base_headers),
        owner,
        repo,
        branch,
    )
    .await
}

/// 消极缓存判定 seam：版本未变 + 24h 内 fresh + 有资产但 sha256 全缺时，
/// checksum 抓取整路跳过。
pub(crate) fn should_skip_checksum_fetch(
    cached_detail: Option<&AppDetail>,
    version_changed: bool,
    now_secs: i64,
) -> bool {
    !version_changed
        && cached_detail
            .map(|c| {
                let fresh = c
                    .cached_at
                    .map(|t| now_secs - t < 24 * 3600)
                    .unwrap_or(false);
                fresh && !c.releases.is_empty() && c.releases.iter().all(|r| r.sha256.is_none())
            })
            .unwrap_or(false)
}

/// checksum 下载直链请求头：仅 UA。release 资产直链不是 GitHub API，
/// 不携带 API `Accept`、`Authorization` 与任何 `If-None-Match`。
fn checksum_download_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(crate::github::http::GH_USER_AGENT),
    );
    headers
}

/// checksum 抓取 seam：消极缓存命中整路跳过，否则以干净下载头经 [`extract_checksums_map`]
/// 返回 `(checksum_map, step_label, skip_or_fail_reason)`。
async fn fetch_checksum_table(
    assets: &[(&str, &str)],
    client: &reqwest::Client,
    skip_checksum: bool,
) -> (HashMap<String, String>, String, Option<String>) {
    if skip_checksum {
        return (
            HashMap::new(),
            "chk:skip(neg_cache)".to_string(),
            Some("negative_cache_24h".to_string()),
        );
    }
    extract_checksums_map(assets, client, &checksum_download_headers()).await
}

/// 多源 `ForgeProvider` Release 资产的 `Checksum Manifest` 填充：按资产名匹配 `sha256`，
/// 返回 `(step_label, skip_or_fail_reason)`。
pub(crate) async fn fill_release_checksums(
    assets: &mut [ReleaseAsset],
    client: &reqwest::Client,
    skip_checksum: bool,
) -> (String, Option<String>) {
    let projection: Vec<(String, String)> = assets
        .iter()
        .map(|a| (a.name.clone(), a.download_url.clone()))
        .collect();
    let refs: Vec<(&str, &str)> = projection
        .iter()
        .map(|(n, u)| (n.as_str(), u.as_str()))
        .collect();
    let (map, step, why) = fetch_checksum_table(&refs, client, skip_checksum).await;
    for asset in assets.iter_mut() {
        if let Some(hash) = map.get(&asset.name) {
            asset.sha256 = Some(hash.clone());
        }
    }
    (step, why)
}

/// release 资产组装 seam：校验过滤 → classify（`forge::provider::classify_asset_fields`
/// 单源，含 `.msix`→setup_exe/windows 特判）→ sha 匹配 → 宿主打分排序。
fn build_release_assets(
    assets: Vec<GitHubAssetResponse>,
    checksums: &HashMap<String, String>,
) -> Vec<ReleaseAsset> {
    let mut releases = Vec::new();
    for asset in assets {
        // 安装包校验过滤：排除 .sha256/.sig/.txt、过滤 <=1MB 占位包、排除源码包
        if !is_valid_installer_asset(&asset.name, asset.size) {
            continue;
        }

        let (kind, os, arch) = crate::forge::provider::classify_asset_fields(&asset.name);
        let matched_sha256 = checksums.get(&asset.name).cloned();

        releases.push(ReleaseAsset {
            name: asset.name.clone(),
            download_url: asset.browser_download_url,
            size_bytes: asset.size,
            sha256: matched_sha256,
            os,
            arch,
            kind,
        });
    }

    // 按当前宿主系统和 CPU 架构智能打分降序排列，最优资产置于 index 0
    releases.sort_by_key(|b| std::cmp::Reverse(crate::installer::score_asset(b)));
    releases
}

/// 显式 `http(s)://` 前缀（ASCII 大小写不敏感）归一为小写协议头，其余原样保留；
/// 非 `http(s)://` 开头返回 `None`。
pub(crate) fn lowercase_http_scheme(trimmed: &str) -> Option<String> {
    for scheme in ["https://", "http://"] {
        if let Some(prefix) = trimmed.get(..scheme.len()) {
            if prefix.eq_ignore_ascii_case(scheme) {
                return Some(format!("{}{}", scheme, &trimmed[scheme.len()..]));
            }
        }
    }
    None
}

/// 合法网络主机：剥尾点后非空、不以 `.` 开头，且为含 `.` 的域名/IPv4、`localhost` 或 `[...]` IPv6。
/// 拒绝 `https://none` 这类单段占位主机。
fn is_network_host(host: &str) -> bool {
    let h = host.trim_end_matches('.');
    !h.is_empty()
        && !h.starts_with('.')
        && (h.contains('.') || h.eq_ignore_ascii_case("localhost") || h.starts_with('['))
}

/// 清洗并规范化主页 URL，拒绝占位词、非 `http(s)` 协议与内嵌凭据。
pub(crate) fn normalize_http_homepage(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    let candidate = match lowercase_http_scheme(trimmed) {
        Some(c) => c,
        None => {
            let host_end = trimmed.find(['/', '?', '#']).unwrap_or(trimmed.len());
            let host = &trimmed[..host_end];
            // `scheme:`（javascript:/mailto:/ftp:///data:）与 `git@host:` 在首个 `/` 前必含 `:` 或 `@`
            if host.contains(':') || host.contains('@') {
                return None;
            }
            if !host.contains('.') || host.starts_with('.') || host.ends_with('.') {
                return None;
            }
            format!("https://{}", trimmed)
        }
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !parsed.host_str().is_some_and(is_network_host)
    {
        return None;
    }
    Some(candidate)
}

/// 可比较主机：小写、去尾点、剥单一前导 `www.`，非默认端口拼 `:port`
///（`Url` 已把 `http:80` / `https:443` 抹平为 `None`）。
fn comparable_host(u: &reqwest::Url) -> Option<String> {
    let host = u.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    Some(match u.port() {
        Some(port) => format!("{}:{}", host, port),
        None => host,
    })
}

/// 可比较仓库路径段：百分号解码、丢空段（折叠 `//` 与尾 `/`）、末段剥 `.git`、小写。
fn comparable_repo_segments<'a>(segments: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = segments
        .filter(|s| !s.is_empty())
        .map(|s| {
            urlencoding::decode(s)
                .map(|d| d.into_owned())
                .unwrap_or_else(|_| s.to_string())
                .to_lowercase()
        })
        .collect();
    if let Some(last) = out.last_mut() {
        if let Some(stripped) = last.strip_suffix(".git") {
            *last = stripped.to_string();
        }
    }
    out
}

/// 判断主页 URL 是否指向当前仓库自身页面。
pub(crate) fn is_same_repo_homepage(
    homepage_url: &str,
    forge_host: &str,
    owner: &str,
    repo: &str,
) -> bool {
    let Ok(hp) = reqwest::Url::parse(homepage_url.trim()) else {
        return false;
    };
    let forge = forge_host.trim();
    let forge = lowercase_http_scheme(forge)
        .map(|s| {
            s.split_once("://")
                .map(|(_, rest)| rest.to_string())
                .unwrap_or(s)
        })
        .unwrap_or_else(|| forge.to_string());
    let forge = forge.trim_end_matches('/');
    let forge = if forge.is_empty() {
        "github.com"
    } else {
        forge
    };
    let Ok(repo_url) = reqwest::Url::parse(&format!("https://{}/", forge)) else {
        return false;
    };
    let (Some(hp_host), Some(repo_host)) = (comparable_host(&hp), comparable_host(&repo_url))
    else {
        return false;
    };
    if hp_host != repo_host {
        return false;
    }
    let repo_path = format!("{}/{}", owner.trim(), repo.trim());
    let want = comparable_repo_segments(repo_path.split('/'));
    if want.len() < 2 {
        return false;
    }
    let got = comparable_repo_segments(hp.path_segments().into_iter().flatten());
    got == want
}

/// 主页决议：收录库与远端各自清洗；收录库优先（合法且非仓库自链时恒取收录库，
/// 仅当收录库缺失/无效，或收录库仅为仓库自链而远端带独立官网时取远端）。
pub(crate) fn resolve_homepage(
    remote: Option<&str>,
    curated: Option<&str>,
    forge_host: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let remote = remote.and_then(normalize_http_homepage);
    let curated = curated.and_then(normalize_http_homepage);
    match (curated, remote) {
        (Some(c), Some(r))
            if is_same_repo_homepage(&c, forge_host, owner, repo)
                && !is_same_repo_homepage(&r, forge_host, owner, repo) =>
        {
            Some(r)
        }
        (c, r) => c.or(r),
    }
}

/// 统计回写 seam：stars/forks 取实时 repo 真值（缺失回退收录库），
/// license/homepage 优先取收录库有效配置，缺失或占位回退 repo 真值。
struct DetailStats {
    stars: u64,
    forks: u64,
    license: String,
    homepage: Option<String>,
}

fn resolve_detail_stats(
    repo_info: Option<&GitHubRepoResponse>,
    catalog_item: Option<&CatalogItem>,
    owner: &str,
    repo: &str,
) -> DetailStats {
    let stars = repo_info
        .and_then(|r| r.stargazers_count)
        .or_else(|| catalog_item.map(|i| i.stars))
        .unwrap_or(0);
    let forks = repo_info
        .and_then(|r| r.forks_count)
        .or_else(|| catalog_item.map(|i| i.forks))
        .unwrap_or(0);
    let curated_license = catalog_item
        .map(|i| i.license.trim())
        .filter(|l| CatalogItem::is_concrete_license(l))
        .map(str::to_string);
    let remote_license = repo_info
        .and_then(|r| r.license.as_ref())
        .and_then(crate::github::models::GitHubLicense::resolve);
    let license = curated_license
        .or(remote_license)
        .or_else(|| catalog_item.map(|i| i.license.trim().to_string()))
        // 未知协议显式记为 "unknown"，不伪装为已验证开源协议。
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let homepage = resolve_homepage(
        repo_info.and_then(|r| r.homepage.as_deref()),
        catalog_item.and_then(|i| i.homepage.as_deref()),
        "github.com",
        owner,
        repo,
    );
    DetailStats {
        stars,
        forks,
        license,
        homepage,
    }
}

/// 简介治愈 seam：未收录仓 external_synth 占位回填 repo 真简介；
/// 已收录仓人工精校优先，不覆盖 desc / description_en。
fn resolve_effective_descriptions(
    catalog_item: Option<&CatalogItem>,
    desc: String,
    repo_info: Option<&GitHubRepoResponse>,
) -> (String, Option<String>) {
    let base_description_en = catalog_item.and_then(|i| i.description_en.clone());
    let repo_real_desc: Option<String> = repo_info
        .and_then(|r| r.description.clone())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| !is_placeholder_description(s));
    let effective_desc: String = if catalog_item.is_none() && is_placeholder_description(&desc) {
        match repo_real_desc.clone() {
            Some(real) => real,
            None => desc,
        }
    } else {
        desc
    };
    let effective_description_en: Option<String> = if catalog_item.is_none() {
        match base_description_en {
            Some(ref e) if !is_placeholder_description(e) => Some(e.clone()),
            base => repo_real_desc.or(base),
        }
    } else {
        base_description_en
    };
    (effective_desc, effective_description_en)
}

/// 校验清单拉取硬超时：留足跨国系统代理经 `github.com` 302 跳转至
/// `objects.githubusercontent.com` 的握手时间，避免误判超时触发未校验门禁。
pub(crate) const CHECKSUM_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);
/// 单个校验清单允许读取的最大字节数（1 MiB），防止误下大文件或恶意超长响应打爆内存。
pub(crate) const MAX_CHECKSUM_BYTES: usize = 1024 * 1024;
/// 聚合清单与单资产 `.sha256` 文件的并发拉取数量上限（遵守 D6 有限并发）。
const MAX_AGGREGATE_CHECKSUM_FETCHES: usize = 4;
const MAX_PER_ASSET_CHECKSUM_FETCHES: usize = 8;

fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 归一名校验清单中的文件名：剥 `*` 二进制标记、外层引号、`./`/`.\\` 及任意目录前缀，保留文件名内空格。
fn normalize_checksum_filename(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_star = trimmed.strip_prefix('*').unwrap_or(trimmed).trim();
    let unquoted = without_star
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(without_star)
        .trim();
    let base = unquoted
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(unquoted)
        .trim();
    (!base.is_empty()).then(|| base.to_string())
}

/// 若资产为单文件校验和（如 `app-win.msi.sha256` / `app.dmg.sha256sum`），推导目标资产名；
/// 聚合清单（如 `SHA256SUMS` / `checksums.txt` / `checksums.sha256`）返回 `None`。
pub(crate) fn infer_per_asset_checksum_target(name: &str) -> Option<String> {
    const SUFFIXES: &[&str] = &[
        ".sha256.txt",
        ".sha256sum.txt",
        ".sha256sums.txt",
        ".sha256",
        ".sha256sum",
        ".sha256sums",
    ];
    let lower = name.to_ascii_lowercase();
    for suf in SUFFIXES {
        if lower.ends_with(suf) {
            let stem = name[..name.len() - suf.len()].trim();
            if stem.is_empty() {
                return None;
            }
            let stem_lower = stem.to_ascii_lowercase();
            if stem_lower.contains("checksum")
                || stem_lower.contains("sha256")
                || stem_lower.contains("shasum")
                || stem_lower.contains("digest")
                || stem_lower == "sums"
                || stem_lower == "hashes"
            {
                return None;
            }
            return Some(stem.to_string());
        }
    }
    None
}

/// 解析校验清单文本（支持 GNU `<hash>  [*][./dir/]name with spaces`、BSD `SHA256 (name) = <hash>`、
/// 以及单资产 `.sha256` 的 1-token 纯哈希行），严格校验 64 位 ASCII 十六进制字符。
pub(crate) fn parse_checksum_manifest(
    text: &str,
    inferred_target: Option<&str>,
    map: &mut HashMap<String, String>,
) {
    let cleaned = text.trim_start_matches('\u{feff}');
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // BSD tag 格式：SHA256 (filename) = <64-hex>
        if let Some(rest) = trimmed
            .get(..6)
            .filter(|p| p.eq_ignore_ascii_case("sha256"))
            .map(|_| trimmed[6..].trim_start())
        {
            if let Some(after_open) = rest.strip_prefix('(') {
                if let Some((raw_name, after_eq)) = after_open.rsplit_once(")=").or_else(|| {
                    after_open
                        .rsplit_once(')')
                        .and_then(|(n, tail)| tail.trim_start().strip_prefix('=').map(|h| (n, h)))
                }) {
                    let hash = after_eq.trim();
                    if is_valid_sha256_hex(hash) {
                        if let Some(filename) = normalize_checksum_filename(raw_name) {
                            map.insert(filename, hash.to_ascii_lowercase());
                        }
                    }
                    continue;
                }
            }
        }

        // 标准格式：首个空白前为哈希，其后整段保留空格作为文件名；无空白则按单 token 哈希处理。
        match trimmed.find(|c: char| c.is_ascii_whitespace()) {
            Some(ws_idx) => {
                let hash = &trimmed[..ws_idx];
                let rest = &trimmed[ws_idx..];
                if is_valid_sha256_hex(hash) {
                    if let Some(filename) = normalize_checksum_filename(rest) {
                        map.insert(filename, hash.to_ascii_lowercase());
                    }
                }
            }
            None => {
                if is_valid_sha256_hex(trimmed) {
                    if let Some(target) = inferred_target {
                        if let Some(filename) = normalize_checksum_filename(target) {
                            map.insert(filename, trimmed.to_ascii_lowercase());
                        }
                    }
                }
            }
        }
    }
}

/// 流式拉取单个校验清单，硬上限 `MAX_CHECKSUM_BYTES`（1 MiB）与整段超时约束。
async fn fetch_single_checksum_manifest(
    url: &str,
    client: &reqwest::Client,
    headers: &HeaderMap,
    timeout: std::time::Duration,
) -> Result<String, (String, String)> {
    use futures_util::StreamExt;
    let deadline = tokio::time::Instant::now() + timeout;
    let send_fut = client.get(url).headers(headers.clone()).send();
    let res = match tokio::time::timeout_at(deadline, send_fut).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return Err((
                "err".to_string(),
                crate::log_support::short_reason(&e.to_string()),
            ));
        }
        Err(_) => {
            return Err((
                "timeout".to_string(),
                format!("timeout_{}s", timeout.as_secs()),
            ));
        }
    };
    let status = res.status().as_u16();
    if !res.status().is_success() {
        return Err((status.to_string(), format!("http_{}", status)));
    }
    if res
        .content_length()
        .is_some_and(|len| len > MAX_CHECKSUM_BYTES as u64)
    {
        return Err(("too_large".to_string(), "exceeds_1mb".to_string()));
    }
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut stream = res.bytes_stream();
    let read_res = tokio::time::timeout_at(deadline, async {
        while let Some(chunk_res) = stream.next().await {
            let chunk = chunk_res.map_err(|_| ("read_err", "read_failed"))?;
            if buf.len().saturating_add(chunk.len()) > MAX_CHECKSUM_BYTES {
                return Err(("too_large", "exceeds_1mb"));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(())
    })
    .await;
    match read_res {
        Ok(Ok(())) => {}
        Ok(Err((tag, reason))) => return Err((tag.to_string(), reason.to_string())),
        Err(_) => return Err(("read_err".to_string(), "read_timeout".to_string())),
    }
    String::from_utf8(buf).map_err(|_| ("decode_err".to_string(), "invalid_utf8".to_string()))
}

impl CatalogService {
    /// GitHub 完整详情拉取：release / repo 并发 ETag 条件请求，README、图标探测与
    /// `Checksum Manifest` 并发补齐。`api_base` 仅换请求前缀（测试指向本地 mock），缓存键不变。
    pub async fn fetch_app_detail(
        &self,
        id: &str,
        prefetch: DetailEtagPrefetch,
        cached_detail: Option<AppDetail>,
        token: Option<&str>,
        api_base: Option<&str>,
    ) -> Result<DetailFetchOutput, String> {
        let mut diag = DetailFetchDiag::default();
        // 身份解析内部 seam：endpoints + 收录项一次取出。
        let DetailIdentity {
            owner,
            repo,
            name,
            desc,
            icon,
            icon_bg,
            catalog_item,
        } = resolve_detail_identity(self, id)?;

        // 详情请求可能携带 Token，固定使用 API 连接池。
        let client = &crate::forge::http::api_client(crate::github::http::api_timeout().as_secs());

        // header/client/log 经 github 内本地 helper。
        let base_headers = crate::github::http::token_headers(token);

        let release_url = crate::github::github_latest_release_endpoint(&owner, &repo);
        let repo_url = crate::github::github_repo_endpoint(&owner, &repo);
        let ((release_outcome, rel_diag), (repo_info, repo_etag_write, repo_diag)) = tokio::join!(
            crate::github::http::get_with_etag_diag(
                client,
                &release_url,
                api_base,
                &base_headers,
                prefetch.release_etag.as_deref(),
            ),
            fetch_repo_info(
                client,
                api_base,
                &base_headers,
                &repo_url,
                prefetch.repo_etag.as_deref(),
                prefetch.repo_payload,
                id,
            )
        );
        let mut etag_writes: Vec<EtagWrite> = Vec::new();
        if let Some(w) = repo_etag_write {
            etag_writes.push(w);
        }
        diag.steps.push(rel_diag.step_label("rel"));
        diag.steps.push(repo_diag.step_label("repo"));
        diag.rate_summary = rel_diag.rate_summary.or(repo_diag.rate_summary);

        // release 401 统一经 crate::check_auth_expired 通知；get_with_etag 已做限流上报。
        let is_auth_unauthorized = matches!(release_outcome, EtagGetOutcome::Unauthorized);
        if is_auth_unauthorized {
            crate::notify_auth_expired();
        }

        if matches!(release_outcome, EtagGetOutcome::NotModified) {
            if let Some(mut detail) =
                reuse_304_cached(cached_detail.as_ref(), catalog_item.as_ref())
            {
                if let Some(ref ri) = repo_info {
                    apply_304_repo_refresh(&mut detail, ri, catalog_item.as_ref(), &owner, &repo);
                }
                diag.steps.push("reuse_304".to_string());
                return Ok(DetailFetchOutput {
                    detail,
                    etag_writes,
                    release_cache_written: false,
                    icon_resolution: None,
                    diag,
                });
            }
        }

        let synthesized_empty_failure: bool;
        let (release_resp, new_cache) = match super::release_fetch::decide_detail_release(
            super::release_fetch::DetailReleaseInput {
                outcome: &release_outcome,
                cached_payload: prefetch.release_payload.as_deref(),
                cached_detail: cached_detail.as_ref(),
                catalog_default_version: catalog_item.as_ref().map(|i| i.default_version.as_str()),
                catalog_description_en: catalog_item
                    .as_ref()
                    .and_then(|i| i.description_en.as_deref()),
                repo_ok: repo_info.is_some(),
                is_auth_unauthorized,
            },
        )? {
            super::release_fetch::DetailReleaseDecision::ReuseStale(mut existing) => {
                // stale 兜底同样走统一自愈（不改 cached_at、保留 is_stale=true）
                super::detail_assets::heal_cached_detail(&mut existing, catalog_item.as_ref());
                diag.steps.push("reuse_stale".to_string());
                return Ok(DetailFetchOutput {
                    detail: *existing,
                    etag_writes,
                    release_cache_written: false,
                    icon_resolution: None,
                    diag,
                });
            }
            super::release_fetch::DetailReleaseDecision::Proceed {
                release,
                cache_to_save,
                synthesized_empty_failure: syn,
            } => {
                synthesized_empty_failure = syn;
                (release, cache_to_save)
            }
        };
        let release_cache_written = new_cache.is_some();
        if let Some((rel_etag, rel_payload)) = new_cache {
            etag_writes.push(EtagWrite {
                url: release_url.clone(),
                etag: rel_etag,
                payload: rel_payload,
                timestamp: crate::github::http::now_secs(),
            });
        }
        if matches!(
            release_outcome,
            EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed
        ) && cached_detail.is_none()
            && prefetch.release_payload.is_none()
            && repo_info.is_some()
        {
            diag.steps.push("rel_fail_repo_ok_empty".to_string());
        }

        let version_changed = cached_detail
            .as_ref()
            .map(|c| c.core.latest_version != release_resp.tag_name)
            .unwrap_or(true);
        let has_cached_readme = cached_detail
            .as_ref()
            .map(|c| !c.readme_markdown.trim().is_empty())
            .unwrap_or(false);
        let cached_readme = cached_detail.as_ref().map(|c| c.readme_markdown.clone());

        let readme_url = crate::github::github_readme_endpoint(&owner, &repo);
        let mut readme_headers = base_headers.clone();
        readme_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3.raw"),
        );
        let default_readme = format!("# {}\n\n{}", name, desc);
        let probe_branch: String = repo_info
            .as_ref()
            .and_then(|r| r.default_branch.clone())
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "HEAD".to_string());
        let has_token = token.map(|t| !t.trim().is_empty()).unwrap_or(false);
        let now_secs = crate::github::http::now_secs();
        let skip_checksum =
            should_skip_checksum_fetch(cached_detail.as_ref(), version_changed, now_secs);
        let checksum_candidates: Vec<(&str, &str)> = release_resp
            .assets
            .iter()
            .map(|a| (a.name.as_str(), a.browser_download_url.as_str()))
            .collect();
        let (
            (raw_readme, readme_etag_write, readme_step),
            probed_hit,
            (checksums, chk_step, chk_why),
        ) = tokio::join!(
            fetch_readme_markdown(ReadmeFetch {
                client,
                api_base,
                url: &readme_url,
                headers: &readme_headers,
                etag: prefetch.readme_etag.as_deref(),
                payload: prefetch.readme_payload.as_ref(),
                version_changed,
                has_cached_readme,
                cached_readme: cached_readme.as_ref(),
                default_readme: &default_readme,
                log_id: id,
            }),
            probe_repo_icon(
                client,
                &base_headers,
                &owner,
                &repo,
                &probe_branch,
                has_token
            ),
            fetch_checksum_table(&checksum_candidates, client, skip_checksum)
        );
        if let Some(w) = readme_etag_write {
            etag_writes.push(w);
        }
        diag.steps.push(readme_step);
        if let Some(ref p) = probed_hit {
            diag.icon_source = Some(p.source.to_string());
            diag.steps.push(format!("icon:{}", p.source));
        } else if !has_token {
            diag.steps.push("icon:anon_miss".to_string());
        } else {
            diag.steps.push("icon:miss".to_string());
        }
        diag.steps.push(chk_step);
        diag.checksum_why = chk_why;
        let probed_with_level =
            probed_hit.map(|p| (crate::icons::ProbeIconLevel::from_source(p.source), p.url));

        let DetailStats {
            stars: latest_stars,
            forks: latest_forks,
            license: latest_license,
            homepage: latest_homepage,
        } = resolve_detail_stats(repo_info.as_ref(), catalog_item.as_ref(), &owner, &repo);

        let (extracted_logo, cleaned_readme) =
            Self::extract_and_strip_logo_from_readme(&raw_readme, &owner, &repo);
        let readme_markdown = Self::rewrite_readme_images(&cleaned_readme, &owner, &repo);

        let releases = build_release_assets(release_resp.assets, &checksums);

        let final_platforms = super::detail_assets::platforms_with_catalog_priority(
            &releases,
            catalog_item.as_ref().map(|i| i.platforms.as_slice()),
        );

        let icon_resolution =
            crate::icons::pick_detail_icon_with_level(&icon, probed_with_level, extracted_logo);
        let final_icon = icon_resolution.icon.clone();

        let (effective_desc, effective_description_en) =
            resolve_effective_descriptions(catalog_item.as_ref(), desc, repo_info.as_ref());

        let mut detail = AppDetail {
            core: AppCore {
                id: id.to_string(),
                name,
                description_en: effective_description_en,
                owner,
                repo,
                icon: final_icon,
                icon_bg,
                description: effective_desc,
                stars: latest_stars,
                forks: latest_forks,
                license: latest_license,
                latest_version: release_resp.tag_name,
                is_verified: catalog_item
                    .as_ref()
                    .map(|i| i.is_verified)
                    .unwrap_or(false),
                category: catalog_item
                    .as_ref()
                    .map(|i| i.category.clone())
                    .unwrap_or_else(|| "system".to_string()),
                category_name: catalog_item
                    .as_ref()
                    .map(|i| i.category_name.clone())
                    .unwrap_or_else(|| "系统实用".to_string()),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: latest_homepage,
                platforms: final_platforms,
                is_cataloged: None,
                source: None,
                status: None,
                added_at: catalog_item.as_ref().and_then(|i| i.added_at.clone()),
                alternatives: catalog_item
                    .as_ref()
                    .map(crate::github::alternatives::resolved_alternatives)
                    .unwrap_or_default(),
            },
            changelog: release_resp.body.unwrap_or_default(),
            readme_markdown,
            readme_variants: if version_changed {
                None
            } else {
                cached_detail
                    .as_ref()
                    .and_then(|c| c.readme_variants.clone())
                    .filter(|v| !v.is_empty())
            },
            releases,
            cached_at: Some(crate::github::http::now_secs()),
            is_stale: if synthesized_empty_failure {
                Some(true)
            } else {
                None
            },
            is_private: repo_info
                .as_ref()
                .and_then(|r| r.private)
                .unwrap_or_else(|| cached_detail.as_ref().is_some_and(|c| c.is_private)),
        };
        if let Some(ref item) = catalog_item {
            item.overlay_detail_core(&mut detail.core);
        }

        Ok(DetailFetchOutput {
            detail,
            etag_writes,
            release_cache_written,
            icon_resolution: Some(icon_resolution),
            diag,
        })
    }
}

/// Checksum Manifest〈校验清单〉拉取 adapter（入参为 `(资产名, 原始 download_url)` 投影，
/// GitHub 与多源 forge 共用）：严守直连/系统代理（绝不经下载镜像），
/// 排除二进制/归档/签名资产，按运行时宿主 OS/Arch 过滤，聚合清单与单资产 `.sha256` 协同拉取，
/// [`CHECKSUM_FETCH_TIMEOUT`] 硬超时与 1 MiB 体积上限约束，失败置空不阻塞；
/// 返回 `(map, step_label, skip_or_fail_reason)` 供宽事件汇总。
pub(crate) async fn extract_checksums_map(
    assets: &[(&str, &str)],
    client: &reqwest::Client,
    headers: &HeaderMap,
) -> (HashMap<String, String>, String, Option<String>) {
    let start = std::time::Instant::now();
    let mut map = HashMap::new();
    let mut first_ineligible: Option<(String, &'static str)> = None;
    let mut aggregate_candidates: Vec<&str> = Vec::new();
    let mut per_asset_candidates: Vec<(String, &str)> = Vec::new();

    for &(name, download_url) in assets {
        let n = name.to_lowercase();
        if !super::detail_assets::is_checksum_manifest_asset(&n) {
            continue;
        }
        let (eligible, reason) = super::detail_assets::checksum_asset_platform_eligible(&n);
        if !eligible {
            if first_ineligible.is_none() {
                first_ineligible = Some((name.to_string(), reason));
            }
            continue;
        }
        match infer_per_asset_checksum_target(name) {
            Some(target) => {
                if per_asset_candidates.len() < MAX_PER_ASSET_CHECKSUM_FETCHES {
                    per_asset_candidates.push((target, download_url));
                }
            }
            None => {
                if aggregate_candidates.len() < MAX_AGGREGATE_CHECKSUM_FETCHES {
                    aggregate_candidates.push(download_url);
                }
            }
        }
    }

    if aggregate_candidates.is_empty() && per_asset_candidates.is_empty() {
        let reason = first_ineligible
            .map(|(f, r)| format!("filtered({}:{})", f, r))
            .unwrap_or_else(|| "no_asset".to_string());
        let step = format!("chk:skip({})", reason);
        return (map, step, Some(reason));
    }

    let checksum_timeout = CHECKSUM_FETCH_TIMEOUT.min(crate::github::http::api_timeout());
    let mut first_err: Option<(String, String)> = None;

    // 1. 优先并发拉取聚合校验清单（SHA256SUMS / checksums.txt 等）
    if !aggregate_candidates.is_empty() {
        let futs = aggregate_candidates
            .iter()
            .map(|url| fetch_single_checksum_manifest(url, client, headers, checksum_timeout));
        for res in futures_util::future::join_all(futs).await {
            match res {
                Ok(text) => parse_checksum_manifest(&text, None, &mut map),
                Err(err) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }
    }

    // 2. 补拉尚未命中哈希的单资产 `.sha256` 文件（按剩余超时预算并发执行）
    let pending_per_asset: Vec<(String, &str)> = per_asset_candidates
        .into_iter()
        .filter(|(target, _)| !map.contains_key(target))
        .collect();
    if !pending_per_asset.is_empty() {
        if let Some(remaining) = checksum_timeout.checked_sub(start.elapsed()) {
            let per_timeout = remaining.max(std::time::Duration::from_millis(500));
            let futs = pending_per_asset.iter().map(|(target, url)| async move {
                let res = fetch_single_checksum_manifest(url, client, headers, per_timeout).await;
                (target.as_str(), res)
            });
            for (target, res) in futures_util::future::join_all(futs).await {
                match res {
                    Ok(text) => parse_checksum_manifest(&text, Some(target), &mut map),
                    Err(err) => {
                        if first_err.is_none() {
                            first_err = Some(err);
                        }
                    }
                }
            }
        }
    }

    if map.is_empty() {
        if let Some((tag, reason)) = first_err {
            let step = format!("chk:{}({}ms)", tag, start.elapsed().as_millis());
            return (map, step, Some(reason));
        }
    }
    let step = format!("chk:ok({},{}ms)", map.len(), start.elapsed().as_millis());
    (map, step, None)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn test_checksum_manifest_fetch_via_unified_interface_degrades_to_empty() {
        // 校验拉取（硬超时，失败置空）：不可达 hostile 对端时返回空表，
        // 不阻塞详情、不 panic。
        // 平台过滤断言见 `detail_assets` 单源覆盖，此处只锁置空行为。
        let url = "http://127.0.0.1:9/x.sha256";
        let assets = [("x.sha256", url)];
        let client = reqwest::Client::new();
        let headers = reqwest::header::HeaderMap::new();
        let (map, _, _) = super::extract_checksums_map(&assets, &client, &headers).await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn test_checksum_table_sends_clean_download_headers() {
        use crate::test_support::{serve, Reply};
        let hash = "b".repeat(64);
        let body = format!("{}  app.msi\n", hash);
        let server = serve(move |_| Reply::ok(body.clone())).await;
        let url = format!("{}/o/r/checksums.sha256", server.base);
        let assets = [("checksums.sha256", url.as_str())];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (map, _, _) = super::fetch_checksum_table(&assets, &client, false).await;
        assert_eq!(map.get("app.msi").map(String::as_str), Some(hash.as_str()));
        let req = server.requests().join("\n").to_ascii_lowercase();
        assert!(!req.contains("authorization:"), "{req}");
        assert!(!req.contains("if-none-match:"), "{req}");
        assert!(!req.contains("application/vnd.github"), "{req}");
    }

    #[tokio::test]
    async fn test_checksum_manifest_fetched_from_original_url_never_mirrored() {
        use crate::test_support::{serve, Reply};
        assert_eq!(super::CHECKSUM_FETCH_TIMEOUT.as_secs(), 6);
        let hash = "a".repeat(64);
        let body = format!("{}  app.msi\n", hash);
        // 请求路径必须是资产原始路径（无镜像前缀改写）。
        let server = serve(move |req| {
            if req.starts_with("GET /o/r/checksums.sha256 ") {
                Reply::ok(body.clone())
            } else {
                Reply::ok("")
            }
        })
        .await;
        let url = format!("{}/o/r/checksums.sha256", server.base);
        let assets = [("checksums.sha256", url.as_str())];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let headers = reqwest::header::HeaderMap::new();
        let (map, step, reason) = super::extract_checksums_map(&assets, &client, &headers).await;
        assert_eq!(
            map.get("app.msi").map(String::as_str),
            Some(hash.as_str()),
            "{step} {reason:?}"
        );
    }

    #[test]
    fn test_parse_checksum_manifest_formats_and_hex_validation() {
        let h1 = "0123456789abcdef".repeat(4);
        let h2 = "ABCDEF0123456789".repeat(4);
        let h3 = "a".repeat(64);
        let h4 = "b".repeat(64);
        let h5 = "c".repeat(64);
        let bad_non_hex = "g".repeat(64);
        let bad_short = "a".repeat(63);
        let body = format!(
            "\u{feff}# comment line\n\
             {h1}  ./dist/win/app-setup.exe\n\
             {h2} *out\\sub\\My App Setup 1.0.msi\n\
             SHA256 (./pkg/Cool App.dmg) = {h3}\n\
             {bad_non_hex}  fake.exe\n\
             {bad_short}  short.exe\n\
             {h4}  \"Quoted Name 2.0.zip\"\n"
        );
        let mut map = std::collections::HashMap::new();
        super::parse_checksum_manifest(&body, None, &mut map);
        assert_eq!(
            map.get("app-setup.exe").map(String::as_str),
            Some(h1.as_str())
        );
        assert_eq!(
            map.get("My App Setup 1.0.msi").map(String::as_str),
            Some(h2.to_ascii_lowercase().as_str())
        );
        assert_eq!(
            map.get("Cool App.dmg").map(String::as_str),
            Some(h3.as_str())
        );
        assert_eq!(
            map.get("Quoted Name 2.0.zip").map(String::as_str),
            Some(h4.as_str())
        );
        assert!(
            !map.contains_key("fake.exe"),
            "non-hex 64 chars must be rejected"
        );
        assert!(
            !map.contains_key("short.exe"),
            "non-64-char hash must be rejected"
        );

        // 1-token 纯哈希 .sha256 推导目标文件名；无目标名时忽略 1-token 行
        let mut single_map = std::collections::HashMap::new();
        super::parse_checksum_manifest(&format!("  {h5}  \n"), None, &mut single_map);
        assert!(single_map.is_empty());
        super::parse_checksum_manifest(
            &format!("  {h5}  \n"),
            Some("tool-1.0.msi"),
            &mut single_map,
        );
        assert_eq!(
            single_map.get("tool-1.0.msi").map(String::as_str),
            Some(h5.as_str())
        );
    }

    #[tokio::test]
    async fn test_extract_checksums_excludes_binaries_and_fetches_multiple_per_asset_sha256() {
        use crate::test_support::{serve, Reply};
        let h1 = "1".repeat(64);
        let h2 = "2".repeat(64);
        let h1_clone = h1.clone();
        let h2_clone = h2.clone();
        let server = serve(move |req| {
            if req.starts_with("GET /app-one.sha256 ") {
                // 1-token hash-only per-asset checksum
                Reply::ok(format!("{h1_clone}\n"))
            } else if req.starts_with("GET /app-two.sha256 ") {
                // 2-token with ./ prefix and spaces in filename
                Reply::ok(format!("{h2_clone}  *./release/My App Two.zip\n"))
            } else {
                Reply::status("404 Not Found")
            }
        })
        .await;

        let u_bin = format!("{}/sha256sum-win.exe", server.base);
        let u_zip = format!("{}/checksum-cli.zip", server.base);
        let u_sig = format!("{}/SHA256SUMS.asc", server.base);
        let u_one = format!("{}/app-one.sha256", server.base);
        let u_two = format!("{}/app-two.sha256", server.base);
        let assets = [
            ("sha256sum-win.exe", u_bin.as_str()),
            ("checksum-cli.zip", u_zip.as_str()),
            ("SHA256SUMS.asc", u_sig.as_str()),
            ("My App One.zip.sha256", u_one.as_str()),
            ("My App Two.zip.sha256", u_two.as_str()),
        ];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let headers = reqwest::header::HeaderMap::new();
        let (map, step, reason) = super::extract_checksums_map(&assets, &client, &headers).await;
        assert_eq!(
            map.get("My App One.zip").map(String::as_str),
            Some(h1.as_str()),
            "{step} {reason:?}"
        );
        assert_eq!(
            map.get("My App Two.zip").map(String::as_str),
            Some(h2.as_str()),
            "{step} {reason:?}"
        );
        let reqs = server.requests().join("\n");
        assert!(!reqs.contains("sha256sum-win.exe"), "{reqs}");
        assert!(!reqs.contains("checksum-cli.zip"), "{reqs}");
        assert!(!reqs.contains("SHA256SUMS.asc"), "{reqs}");
    }

    #[tokio::test]
    async fn test_extract_checksums_rejects_oversized_manifest_over_1mb() {
        use crate::test_support::{serve, Reply};
        let huge = vec![b'a'; super::MAX_CHECKSUM_BYTES + 128];
        let server = serve(move |_| Reply::ok(huge.clone())).await;
        let url = format!("{}/SHA256SUMS", server.base);
        let assets = [("SHA256SUMS", url.as_str())];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let headers = reqwest::header::HeaderMap::new();
        let (map, step, reason) = super::extract_checksums_map(&assets, &client, &headers).await;
        assert!(map.is_empty());
        assert!(step.starts_with("chk:too_large"), "{step}");
        assert_eq!(reason.as_deref(), Some("exceeds_1mb"));
    }

    #[test]
    fn test_resolve_detail_stats_license_unknown_sentinel() {
        // repo 无 license 且无收录兜底时显式 `unknown`（诚实未知，不伪装
        // 已验证开源）；repo spdx 优先，缺失回退收录库。
        let stats = super::resolve_detail_stats(None, None, "o", "r");
        assert_eq!(stats.license, "unknown");

        let repo_no_license = super::GitHubRepoResponse {
            name: None,
            full_name: None,
            html_url: None,
            description: None,
            stargazers_count: None,
            forks_count: None,
            language: None,
            license: Some(crate::github::models::GitHubLicense {
                key: None,
                spdx_id: None,
            }),
            homepage: None,
            default_branch: None,
            fork: None,
            pushed_at: None,
            updated_at: None,
            private: None,
        };
        let stats = super::resolve_detail_stats(Some(&repo_no_license), None, "o", "r");
        assert_eq!(stats.license, "unknown");

        let bare_item = crate::github::models::CatalogItem {
            id: "o/r".to_string(),
            name: "R".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v0.1.0".to_string(),
            added_at: None,
            license: String::new(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec![],
            identifiers: std::collections::HashMap::new(),
        };
        let stats = super::resolve_detail_stats(Some(&repo_no_license), Some(&bare_item), "o", "r");
        assert_eq!(stats.license, "unknown");

        let mut licensed = bare_item.clone();
        licensed.license = "MIT".to_string();
        let stats = super::resolve_detail_stats(Some(&repo_no_license), Some(&licensed), "o", "r");
        assert_eq!(stats.license, "MIT");

        let repo_mit = super::GitHubRepoResponse {
            license: Some(crate::github::models::GitHubLicense {
                key: Some("mit".to_string()),
                spdx_id: Some("MIT".to_string()),
            }),
            ..repo_no_license.clone()
        };
        let stats = super::resolve_detail_stats(Some(&repo_mit), None, "o", "r");
        assert_eq!(stats.license, "MIT");

        // NOASSERTION 时回退到合法 key（如 "mit" -> "MIT"）
        let repo_key_fallback = super::GitHubRepoResponse {
            license: Some(crate::github::models::GitHubLicense {
                key: Some("mit".to_string()),
                spdx_id: Some("NOASSERTION".to_string()),
            }),
            ..repo_no_license
        };
        let stats = super::resolve_detail_stats(Some(&repo_key_fallback), None, "o", "r");
        assert_eq!(stats.license, "MIT");
    }

    #[test]
    fn test_normalize_http_homepage_keeps_web_urls_and_rejects_junk() {
        use super::normalize_http_homepage as n;
        assert_eq!(n("https://zed.dev").as_deref(), Some("https://zed.dev"));
        assert_eq!(n("http://gitup.co").as_deref(), Some("http://gitup.co"));
        assert_eq!(
            n("  HTTPS://Example.com/docs?x=1#top  ").as_deref(),
            Some("https://Example.com/docs?x=1#top")
        );
        assert_eq!(n("zed.dev").as_deref(), Some("https://zed.dev"));
        assert_eq!(
            n("www.7-zip.org/download.html").as_deref(),
            Some("https://www.7-zip.org/download.html")
        );
        for junk in [
            "",
            "   ",
            "None",
            "N/A",
            "TBD",
            "javascript:alert(1)",
            "mailto:a@b.com",
            "ftp://files.example.com",
            "data:text/html,hi",
            "https://user:pass@example.com",
            "https://example.com with space",
            "https://none",
            "git@github.com:o/r.git",
        ] {
            assert_eq!(n(junk), None, "{junk:?} must be rejected");
        }
    }

    #[test]
    fn test_is_same_repo_homepage_matches_repo_page_variants_only() {
        use super::is_same_repo_homepage as same;
        for hp in [
            "https://github.com/BurntSushi/ripgrep",
            "https://github.com/burntsushi/ripgrep/",
            "http://www.github.com/BurntSushi/ripgrep.git",
            "https://github.com/BurntSushi/ripgrep#readme",
            "https://github.com/BurntSushi/ripgrep?tab=readme-ov-file",
            "https://github.com:443/BurntSushi//ripgrep///",
        ] {
            assert!(same(hp, "github.com", "BurntSushi", "ripgrep"), "{hp}");
        }
        assert!(same("https://github.com/o/r", "", "o", "r"));
        assert!(!same(
            "https://github.com/apps/desktop",
            "github.com",
            "desktop",
            "desktop"
        ));
        assert!(!same("https://github.com/o/r/wiki", "github.com", "o", "r"));
        assert!(!same(
            "https://gitlab.com/OpenMW/openmw",
            "github.com",
            "OpenMW",
            "openmw"
        ));
        assert!(!same("https://o.github.io/r", "github.com", "o", "r"));
        assert!(same(
            "https://git.example.com:8443/Org/App",
            "git.example.com:8443",
            "org",
            "app"
        ));
        assert!(!same(
            "https://git.example.com:9443/org/app",
            "git.example.com:8443",
            "org",
            "app"
        ));
        assert!(same(
            "https://codeberg.org/FreeTubeApp/FreeTube/",
            "https://codeberg.org/",
            "FreeTubeApp",
            "FreeTube"
        ));
    }

    #[test]
    fn test_resolve_detail_stats_homepage_sanitizes_and_keeps_curated_external() {
        let repo_base = super::GitHubRepoResponse {
            name: None,
            full_name: None,
            html_url: None,
            description: None,
            stargazers_count: None,
            forks_count: None,
            language: None,
            license: None,
            homepage: None,
            default_branch: None,
            fork: None,
            pushed_at: None,
            updated_at: None,
            private: None,
        };
        let item = crate::github::models::CatalogItem {
            id: "OpenMW/openmw".to_string(),
            name: "OpenMW".to_string(),
            owner: "OpenMW".to_string(),
            repo: "openmw".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "game".to_string(),
            category_name: "游戏".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v0.1.0".to_string(),
            added_at: None,
            license: "GPL-3.0".to_string(),
            stars: 0,
            forks: 0,
            is_verified: false,
            homepage: Some("https://gitlab.com/OpenMW/openmw".to_string()),
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec![],
            identifiers: std::collections::HashMap::new(),
        };
        let stats_for = |hp: &str| {
            let repo = super::GitHubRepoResponse {
                homepage: Some(hp.to_string()),
                ..repo_base.clone()
            };
            super::resolve_detail_stats(Some(&repo), Some(&item), "OpenMW", "openmw").homepage
        };
        let curated = Some("https://gitlab.com/OpenMW/openmw".to_string());
        assert_eq!(stats_for("N/A"), curated);
        assert_eq!(stats_for("ftp://files.example.com"), curated);
        assert_eq!(stats_for("https://github.com/OpenMW/openmw"), curated);
        // 收录库已有独立官网时，优先取收录库而非远端官网
        assert_eq!(stats_for("HTTPS://openmw.org"), curated);

        // 收录库仅填仓库自链时，远端独立官网可回填展示
        let mut self_link_item = item.clone();
        self_link_item.homepage = Some("https://github.com/OpenMW/openmw".to_string());
        let repo_ext = super::GitHubRepoResponse {
            homepage: Some("HTTPS://openmw.org".to_string()),
            ..repo_base.clone()
        };
        assert_eq!(
            super::resolve_detail_stats(Some(&repo_ext), Some(&self_link_item), "OpenMW", "openmw")
                .homepage
                .as_deref(),
            Some("https://openmw.org")
        );

        // 无精校主页时仓库自链照常透出（前端判重负责隐藏）
        let repo_self = super::GitHubRepoResponse {
            homepage: Some("https://github.com/OpenMW/openmw".to_string()),
            ..repo_base
        };
        let stats = super::resolve_detail_stats(Some(&repo_self), None, "OpenMW", "openmw");
        assert_eq!(
            stats.homepage.as_deref(),
            Some("https://github.com/OpenMW/openmw")
        );
    }

    #[test]
    fn test_resolve_detail_stats_prefers_catalog_concrete_license_over_repo() {
        let repo_mit = super::GitHubRepoResponse {
            name: None,
            full_name: None,
            html_url: None,
            description: None,
            stargazers_count: Some(500),
            forks_count: Some(20),
            language: None,
            license: Some(crate::github::models::GitHubLicense {
                key: Some("apache-2.0".to_string()),
                spdx_id: Some("Apache-2.0".to_string()),
            }),
            homepage: None,
            default_branch: None,
            fork: None,
            pushed_at: None,
            updated_at: None,
            private: None,
        };
        let item = crate::github::models::CatalogItem {
            id: "o/r".to_string(),
            name: "R".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v0.1.0".to_string(),
            added_at: None,
            license: "MIT".to_string(),
            stars: 10,
            forks: 1,
            is_verified: false,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec![],
            identifiers: std::collections::HashMap::new(),
        };
        let stats = super::resolve_detail_stats(Some(&repo_mit), Some(&item), "o", "r");
        assert_eq!(stats.license, "MIT");
        assert_eq!(stats.stars, 500);
        assert_eq!(stats.forks, 20);

        // 收录库为占位协议时，由远端具体 SPDX 补齐
        let mut placeholder_item = item;
        placeholder_item.license = "OpenSource".to_string();
        let stats_placeholder =
            super::resolve_detail_stats(Some(&repo_mit), Some(&placeholder_item), "o", "r");
        assert_eq!(stats_placeholder.license, "Apache-2.0");
    }

    #[test]
    fn test_repo_real_description_from_etag_filters_placeholder() {
        let db = crate::db::Database::open_in_memory().unwrap();
        // 无行时为 None
        assert!(super::repo_real_description_from_etag(&db, "o", "r").is_none());
        // 真值命中
        db.save_etag(
            "https://api.github.com/repos/o/r",
            "e1",
            r#"{"description": "Real desc"}"#,
            crate::github::http::now_secs(),
        )
        .unwrap();
        assert_eq!(
            super::repo_real_description_from_etag(&db, "o", "r").as_deref(),
            Some("Real desc")
        );
        // 占位 payload 视为无真值
        db.save_etag(
            "https://api.github.com/repos/p/q",
            "e2",
            r#"{"description": "GitHub 社区开源项目"}"#,
            crate::github::http::now_secs(),
        )
        .unwrap();
        assert!(super::repo_real_description_from_etag(&db, "p", "q").is_none());
        // 空 owner/repo 直接 None
        assert!(super::repo_real_description_from_etag(&db, "", "r").is_none());
    }

    #[test]
    fn test_pick_detail_icon_with_level_preserves_l4_and_dual_l3_l4() {
        // 1. L2/L3 未命中，仅提取到 README Logo（哪怕经 clean_image_url 改写为 /HEAD/ 或外部图床），level 恒为 4。
        let res_l4 = crate::icons::pick_detail_icon_with_level(
            "",
            None,
            Some("https://raw.githubusercontent.com/owner/repo/HEAD/assets/logo.png".to_string()),
        );
        assert_eq!(
            res_l4.icon,
            "https://raw.githubusercontent.com/owner/repo/HEAD/assets/logo.png"
        );
        assert_eq!(res_l4.level, Some(4));
        assert_eq!(res_l4.extra_l4_url, None);

        // 2. L3（Git Trees）与 L4（README）同时命中：主展示为 L3（level=3），同时保留 extra_l4_url 供补齐备选槽。
        let res_dual = crate::icons::pick_detail_icon_with_level(
            "",
            Some((
                crate::icons::ProbeIconLevel::L3Trees,
                "https://raw.githubusercontent.com/owner/repo/main/res/icon.png".to_string(),
            )),
            Some("https://media.example.com/readme-banner-logo.png".to_string()),
        );
        assert_eq!(
            res_dual.icon,
            "https://raw.githubusercontent.com/owner/repo/main/res/icon.png"
        );
        assert_eq!(res_dual.level, Some(3));
        assert_eq!(
            res_dual.extra_l4_url.as_deref(),
            Some("https://media.example.com/readme-banner-logo.png")
        );
    }

    #[test]
    fn test_heal_cached_detail_fixes_maccy_stale_and_304_preserves_concrete_license_and_zero_stars()
    {
        // 1. Stale 兜底自愈：旧库里被错标为 windows 的 Maccy.app.zip 应纠正为 macos 且保留 is_stale
        let mut stale_maccy = crate::models::AppDetail {
            core: crate::models::AppCore {
                id: "p0deje/maccy".to_string(),
                name: "Maccy".to_string(),
                description_en: None,
                owner: "p0deje".to_string(),
                repo: "Maccy".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "Clipboard manager".to_string(),
                stars: 100,
                forks: 10,
                license: "MIT".to_string(),
                latest_version: "v2.0.0".to_string(),
                is_verified: true,
                category: "tools".to_string(),
                category_name: "效率工具".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: String::new(),
            readme_markdown: "# Maccy".to_string(),
            readme_variants: None,
            releases: vec![crate::models::ReleaseAsset {
                name: "Maccy.app.zip".to_string(),
                download_url: "https://example.com/Maccy.app.zip".to_string(),
                size_bytes: 5_288_775,
                sha256: None,
                os: "windows".to_string(),
                arch: "universal".to_string(),
                kind: "portable_zip".to_string(),
            }],
            cached_at: Some(12345),
            is_stale: Some(true),
            is_private: false,
        };
        crate::github::detail_assets::heal_cached_detail(&mut stale_maccy, None);
        assert_eq!(stale_maccy.releases[0].os, "macos");
        assert_eq!(stale_maccy.core.platforms, vec!["macos".to_string()]);
        assert_eq!(stale_maccy.is_stale, Some(true));
        assert_eq!(stale_maccy.cached_at, Some(12345));

        // 2. 304 刷新：收录库为 OpenSource 占位且远端 license=None 时保留缓存的 MIT；远端 stars=0 时不被旧值保留
        let mut cached = stale_maccy.clone();
        cached.is_stale = None;
        let placeholder_item = crate::github::models::CatalogItem {
            id: "p0deje/maccy".to_string(),
            name: "Maccy".to_string(),
            owner: "p0deje".to_string(),
            repo: "Maccy".to_string(),
            icon: String::new(),
            icon_bg: String::new(),
            description: String::new(),
            description_en: None,
            category: "tools".to_string(),
            category_name: "效率工具".to_string(),
            aliases: vec![],
            alternatives: Vec::new(),
            default_version: "v2.0.0".to_string(),
            added_at: None,
            license: "OpenSource".to_string(),
            stars: 999,
            forks: 88,
            is_verified: true,
            homepage: None,
            install_dirs: vec![],
            search_subdirs: vec![],
            publishers: vec![],
            platforms: vec![],
            identifiers: std::collections::HashMap::new(),
        };
        let repo_zero = super::GitHubRepoResponse {
            name: None,
            full_name: None,
            html_url: None,
            description: None,
            stargazers_count: Some(0),
            forks_count: Some(0),
            language: None,
            license: None,
            homepage: None,
            default_branch: None,
            fork: None,
            pushed_at: None,
            updated_at: None,
            private: None,
        };
        super::apply_304_repo_refresh(
            &mut cached,
            &repo_zero,
            Some(&placeholder_item),
            "p0deje",
            "Maccy",
        );
        assert_eq!(cached.core.license, "MIT");
        assert_eq!(cached.core.stars, 0);
        assert_eq!(cached.core.forks, 0);
    }
}
