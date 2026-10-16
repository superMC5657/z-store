use super::detail_assets::is_valid_installer_asset;
use crate::github::developer_profile::EtagGetOutcome;
use crate::github::models::{CatalogItem, GitHubAssetResponse, GitHubRepoResponse};
use crate::github::CatalogService;
use crate::installer::InstallerEngine;
use crate::models::{AppDetail, ReleaseAsset};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, IF_NONE_MATCH};
use std::collections::HashMap;

/// repo/readme ETag 预读统一经此 helper（force 时跳过 DB；
/// 冷启动 DB 无行亦为 None）。release 的调用方传入缓存不在此读 DB，三处调用指
/// repo 预读 + readme 预读（+ release 调用方同模式，见 commands/catalog）。
fn cached_etag_payload(url: &str, is_force_like: bool) -> (Option<String>, Option<String>) {
    if is_force_like {
        return (None, None);
    }
    if let Some(db) = crate::github::http::open_db_opt() {
        let et = db.get_etag(url).ok().flatten();
        let pl = db.get_cached_payload(url).ok().flatten();
        (et, pl)
    } else {
        (None, None)
    }
}

fn parse_repo_payload(payload: Option<&String>) -> Option<GitHubRepoResponse> {
    payload.and_then(|pl| serde_json::from_str::<GitHubRepoResponse>(pl).ok())
}

/// B1：详情简介占位判断（未收录仓 external_synth / search 回退占位）。
/// 空白视为占位（前端渲染兜底）；命中任一已知占位子串即视为占位。
/// 已收录仓人工精校简介优先，调用方需以 `catalog_item.is_none()` 门控后再回填。
pub(crate) fn is_placeholder_description(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return true;
    }
    const PLACEHOLDERS: &[&str] = &[
        "GitHub 社区开源项目",
        "开源软件项目",
        "跨平台开源项目",
        "暂无简介",
        "暂无描述",
        "No description available",
    ];
    if PLACEHOLDERS.iter().any(|p| t.contains(p)) {
        return true;
    }
    // 英文占位大小写不敏感兜底
    t.to_lowercase().contains("no description available")
}

/// 最近浏览简介占位后端根治共用：从 SQLite ETag 缓存读 repo 真简介（同步读，不触网）。
/// - key 为 `https://api.github.com/repos/{owner}/{repo}`（原值 + 小写各试一次）；
/// - payload 按 `GitHubRepoResponse.description` 解析，trim 后空或仍占位视为无真值；
/// - 调用方需以 `catalog_item.is_none()` 门控（已收录仓人工精校优先，不覆盖）。
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
    let raw = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let lowered = format!(
        "https://api.github.com/repos/{}/{}",
        owner.to_lowercase(),
        repo.to_lowercase()
    );
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

// ---------------------------------------------------------------------------
// detail 内部 seams：对外 `fetch_app_detail` 单一入口；
// repo/readme/probe/checksum/platform/desc 各为内部函数。
// ADR-0004〈streaming + SHA256 vs checksums.txt fail=destroy〉/
// ADR-0002〈mirror 只改下载 URL〉/ ADR-0006〈ForgeProvider vs doforce 例外〉语义于此编码。
// ---------------------------------------------------------------------------

/// detail 身份：endpoints + 收录项（各 seam 共享输入，一次取出）。
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
    let (owner, repo, name, desc, icon, icon_bg) = svc.get_endpoints(id)?;
    let catalog_item = svc
        .items
        .read()
        .ok()
        .and_then(|items| items.iter().find(|i| i.id == id).cloned());
    Ok(DetailIdentity {
        owner,
        repo,
        name,
        desc,
        icon,
        icon_bg,
        catalog_item,
    })
}

/// repo 抓取 seam：ETag 条件请求 + HttpSpan + Fresh 落库 + 回退解析
///（401 经 `check_auth_expired` 统一通知 + warn；限流上报在 `get_with_etag` 内）。
async fn fetch_repo_info(
    client: &reqwest::Client,
    base_headers: &HeaderMap,
    repo_url: &str,
    repo_etag: Option<&str>,
    repo_payload: Option<String>,
    id: &str,
) -> Option<GitHubRepoResponse> {
    // H7/HttpSpan：repo 并发请求经 forge HttpSpan（log_search_* 分支），
    // 经 get_with_etag 挂 IF_NONE_MATCH，304 时用 SQLite payload 恢复。
    let repo_span = crate::forge::http::HttpSpan::start(repo_url);
    repo_span.log_search_start("repo");
    let outcome = CatalogService::get_with_etag(
        client,
        repo_url,
        None,
        base_headers,
        repo_etag,
        "detail-repo",
    )
    .await;
    // repo ETag 响应的 401/限流处理与日志（get_with_etag 已做限流上报，此处补 HttpSpan + 401 通知）。
    // H7：401 经 crate::check_auth_expired 统一通知 + warn；日志经 HttpSpan 统一收敛。
    // Fresh 落库 api_etag_cache；304/失败时用 SQLite payload 恢复，避免每次全量。
    // NotModified/Unauthorized/Failed 回退解析合并，日志分支内部分发。
    match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            repo_span.log_search_done("repo", 200);
            if let Some(et) = etag {
                if let Some(db) = crate::github::http::open_db_opt() {
                    let _ = db.save_etag(repo_url, &et, &text, crate::github::http::now_secs());
                }
            }
            serde_json::from_str::<GitHubRepoResponse>(&text).ok()
        }
        other => {
            match &other {
                EtagGetOutcome::NotModified => {
                    repo_span.log_search_done("repo", 304);
                }
                EtagGetOutcome::Unauthorized => {
                    repo_span.log_search_done("repo", 401);
                    crate::check_auth_expired(401, &format!("op=detail-repo id={}", id));
                }
                _ => {
                    repo_span.log_search_fail("repo", "fetch failed");
                }
            }
            parse_repo_payload(repo_payload.as_ref())
        }
    }
}

/// 304 零开销复用 seam：release 未变 + 本地有完整缓存（releases 非空 + readme 非空）直接复用；
/// deduce + ios 并集经内部平台 seam 单口，description_en 收录精校回填，时间戳收敛 now_secs。
fn reuse_304_cached(
    cached_detail: Option<&AppDetail>,
    catalog_item: Option<&CatalogItem>,
) -> Option<AppDetail> {
    let existing = cached_detail?;
    if existing.releases.is_empty() || existing.readme_markdown.trim().is_empty() {
        return None;
    }
    let mut detail = existing.clone();
    detail.releases.retain(|r| is_valid_installer_asset(&r.name, r.size_bytes));
    // deduce + ios 并集 + 排序经内部平台 seam（与成功路径共用）。
    detail.platforms = unioned_detail_platforms(&detail.releases, catalog_item);
    if let Some(item) = catalog_item {
        if item.description_en.is_some() {
            detail.description_en = item.description_en.clone();
        }
    }
    detail.cached_at = Some(crate::github::http::now_secs());
    detail.is_stale = None;
    Some(detail)
}

/// readme 抓取输入束（多参数成束，避免长参数列在 join 点散开）。
struct ReadmeFetch<'a> {
    client: &'a reqwest::Client,
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

/// readme 抓取 seam：版本未变 + 有缓存直接复用；否则 ETag 条件请求
///（304 用 SQLite payload / cached_readme 恢复；401 经 `check_auth_expired` 通知后回退；
/// 失败用 cached_readme 或默认回退）。
async fn fetch_readme_markdown(req: ReadmeFetch<'_>) -> String {
    // 版本未发生变动且已有 README 缓存，不重复发网络请求拉取
    if !req.version_changed && req.has_cached_readme {
        if let Some(r) = req.cached_readme {
            return r.clone();
        }
    }
    match CatalogService::get_with_etag(
        req.client,
        req.url,
        None,
        req.headers,
        req.etag,
        "detail-readme",
    )
    .await
    {
        EtagGetOutcome::Fresh { text, etag } => {
            if let Some(et) = etag {
                if let Some(db) = crate::github::http::open_db_opt() {
                    let _ = db.save_etag(req.url, &et, &text, crate::github::http::now_secs());
                }
            }
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
    }
}

/// icon 探测 seam：无 token 直接跳过不计时、不耗配额；有 token 才进 SimpleIcons+Trees
///（命中原样回传，source 日志由调用方记）。
async fn probe_repo_icon(
    client: &reqwest::Client,
    base_headers: &HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
    has_token: bool,
) -> Option<crate::github::icon_probe::ProbedIcon> {
    if !has_token {
        return None;
    }
    crate::github::icon_probe::probe_repo_logo(client, Some(base_headers), owner, repo, branch)
        .await
}

/// 消极缓存判定 seam：版本未变 + 24h 内 fresh + 有资产但 sha256 全缺时，
/// checksum 抓取整路跳过。
fn checksum_negative_hit(
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

/// checksum 抓取 seam：消极缓存命中整路跳过，否则经 `extract_checksums_map`
///（3s 硬超时，失败置空不阻塞）。
async fn fetch_checksum_table(
    assets: &[GitHubAssetResponse],
    client: &reqwest::Client,
    headers: &HeaderMap,
    app_id: &str,
    sid: &str,
    req_id: &str,
    negative_hit: bool,
) -> HashMap<String, String> {
    if negative_hit {
        log::debug!(
            "checksum skip id={} sid={} req={} reason=negative_cache_hit_24h",
            app_id,
            sid,
            req_id
        );
        return HashMap::new();
    }
    CatalogService::extract_checksums_map(assets, client, headers, app_id, sid, req_id).await
}

/// release 资产组装 seam：校验过滤 → classify → sha 匹配 → 宿主打分排序。
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

        let (kind, os, arch) = InstallerEngine::classify_asset(&asset.name);
        // kind 映射经 `installer::AssetKind::as_str()` 单一实现；
        // 仅 `.msix` 保留 setup_exe（classify 归 Other）。
        let kind_str = match &kind {
            crate::installer::AssetKind::Other
                if asset.name.to_lowercase().ends_with(".msix") =>
            {
                "setup_exe"
            }
            _ => kind.as_str(),
        };

        let matched_sha256 = checksums.get(&asset.name).cloned();

        releases.push(ReleaseAsset {
            name: asset.name.clone(),
            download_url: asset.browser_download_url,
            size_bytes: asset.size,
            sha256: matched_sha256,
            os: if os == "all" && asset.name.to_lowercase().ends_with(".msix") {
                "windows".to_string()
            } else {
                os.to_string()
            },
            arch: arch.to_string(),
            kind: kind_str.to_string(),
        });
    }

    // 按当前宿主系统和 CPU 架构智能打分降序排列，最优资产置于 index 0
    releases.sort_by_key(|b| std::cmp::Reverse(crate::installer::score_asset(b)));
    releases
}

/// 平台推导 seam：deduce + ios 并集 + 排序经 `detail_assets` 单口
///（304 快径与成功路径共用）。
fn unioned_detail_platforms(
    releases: &[ReleaseAsset],
    catalog_item: Option<&CatalogItem>,
) -> Vec<String> {
    super::detail_assets::platforms_with_ios_union(
        releases,
        catalog_item.map(|i| i.platforms.as_slice()),
    )
}

/// 统计回写 seam：repo 真值优先，缺失回退收录库（stars/forks/license/homepage；homepage 空与无协议头归一）。
struct DetailStats {
    stars: u64,
    forks: u64,
    license: String,
    homepage: Option<String>,
}

fn resolve_detail_stats(
    repo_info: Option<&GitHubRepoResponse>,
    catalog_item: Option<&CatalogItem>,
) -> DetailStats {
    let stars = repo_info
        .and_then(|r| r.stargazers_count)
        .or_else(|| catalog_item.map(|i| i.stars))
        .unwrap_or(0);
    let forks = repo_info
        .and_then(|r| r.forks_count)
        .or_else(|| catalog_item.map(|i| i.forks))
        .unwrap_or(0);
    let license = repo_info
        .and_then(|r| r.license.as_ref())
        .and_then(|l| l.spdx_id.clone())
        .or_else(|| catalog_item.map(|i| i.license.clone()))
        .unwrap_or_else(|| "FLOSS".to_string());
    let homepage = repo_info
        .and_then(|r| r.homepage.clone())
        .filter(|h| !h.trim().is_empty())
        .or_else(|| catalog_item.and_then(|i| i.homepage.clone()))
        .filter(|h| !h.trim().is_empty())
        .map(|h| {
            let trimmed = h.trim();
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                trimmed.to_string()
            } else {
                format!("https://{}", trimmed)
            }
        });
    DetailStats {
        stars,
        forks,
        license,
        homepage,
    }
}

/// B1 简介治愈 seam：未收录仓 external_synth 占位回填 repo 真简介；
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
    let effective_desc: String =
        if catalog_item.is_none() && is_placeholder_description(&desc) {
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

impl CatalogService {
    pub async fn fetch_app_detail(
        &self,
        id: &str,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
        cached_detail: Option<AppDetail>,
        token: Option<&str>,
    ) -> Result<(AppDetail, Option<(String, String)>), String> {
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

        let client = &self.client;

        // H1/H2/H3：header/client/log 经 github 内本地 helper。
        let base_headers = crate::github::http::token_headers(token);
        let mut headers = base_headers.clone();

        if let Some(ref etag) = cached_etag {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }

        let release_url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
        let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let (req_id, sid) = crate::github::http::new_log_ctx();
        // 首屏快速路径 (1)：release ∥ repo 并发发射。repo 仅需 owner/repo，
        // 与 release 响应无任何依赖，故两个原始请求同时在途，重叠 TLS 握手与首字节等待。
        // repo 同样经 get_with_etag 走 SQLite ETag 缓存（304 命中直接用缓存 payload），
        // 与 release 一致零配额；401/限流语义一致。
        // H9：release 复用已有 get_with_etag（304/200/ETag 与 developer_* 共用实现）。
        // force 语义：调用方 force 时传入全 None，此时跳过 DB 预读；
        // 冷启动同样全 None（DB 无行，预读亦为 None），语义一致。
        // repo 侧经 `fetch_repo_info` 内部 seam（HttpSpan/落库/回退在内），join 并发。
        let is_force_like =
            cached_etag.is_none() && cached_payload.is_none() && cached_detail.is_none();
        let (repo_etag, repo_payload) = cached_etag_payload(&repo_url, is_force_like);
        let (release_outcome, repo_info) = tokio::join!(
            Self::get_with_etag(
                client,
                &release_url,
                None,
                &base_headers,
                cached_etag.as_deref(),
                "detail-release",
            ),
            fetch_repo_info(
                client,
                &base_headers,
                &repo_url,
                repo_etag.as_deref(),
                repo_payload,
                id,
            )
        );

        // H7：release 401 统一经 crate::check_auth_expired 通知；H9 的 get_with_etag 已做限流上报。
        let is_auth_unauthorized = matches!(release_outcome, EtagGetOutcome::Unauthorized);
        if is_auth_unauthorized {
            crate::notify_auth_expired();
        }

        // 核心提速门禁：若 GitHub 返回 304 Not Modified（说明最新 Release 版本完全未变）
        // 且本地已有完整缓存详情，直接零网络开销复用已有 README 与 Release 资产，实现 ~50ms 闪电响应
        //（经 `reuse_304_cached` 内部 seam，deduce+ios 并集经平台 seam 单口）。
        if matches!(release_outcome, EtagGetOutcome::NotModified) {
            if let Some(detail) = reuse_304_cached(cached_detail.as_ref(), catalog_item.as_ref())
            {
                return Ok((detail, None));
            }
        }

        // 收敛：release 决议经 `github::release_fetch` deep adapter（与 shallow 同一模块；
        // repo/README/Checksum Manifest〈校验清单〉/平台推导仍在本函数继续，图标段不动）。
        let synthesized_empty_failure: bool;
        let (release_resp, new_cache) = match super::release_fetch::decide_detail_release(
            super::release_fetch::DetailReleaseInput {
                outcome: &release_outcome,
                cached_payload: cached_payload.as_deref(),
                cached_detail: cached_detail.as_ref(),
                catalog_default_version: catalog_item
                    .as_ref()
                    .map(|i| i.default_version.as_str()),
                catalog_description_en: catalog_item
                    .as_ref()
                    .and_then(|i| i.description_en.as_deref()),
                repo_ok: repo_info.is_some(),
                is_auth_unauthorized,
            },
        )? {
            super::release_fetch::DetailReleaseDecision::ReuseStale(existing) => {
                // 离线或网络异常回退：若有 cached_detail 直接使用（stale 穿透，不 touch 不落库）。
                return Ok((*existing, None));
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
        // 诊断日志：releases/latest 单点 Failed 但 repo 存活时的 fresh 空行
        //（谓词：失败 outcome + 无旧行 + 无 payload + repo 存活）。
        if matches!(
            release_outcome,
            EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed
        ) && cached_detail.is_none()
            && cached_payload.is_none()
            && repo_info.is_some()
        {
            log::debug!(
                "detail release empty but repo ok id={} sid={} req={} reason=release_failed_repo_ok_fresh_empty",
                id,
                sid,
                req_id
            );
        }

        // 判断版本是否变化以及是否已有缓存的 README
        let version_changed = cached_detail
            .as_ref()
            .map(|c| c.latest_version != release_resp.tag_name)
            .unwrap_or(true);
        let has_cached_readme = cached_detail
            .as_ref()
            .map(|c| !c.readme_markdown.trim().is_empty())
            .unwrap_or(false);
        let cached_readme = cached_detail.as_ref().map(|c| c.readme_markdown.clone());

        // 首屏快速路径 (2)：保持 join(release,repo) 后，
        // readme + probe_repo_logo + checksums 三路 join 并发。
        // checksum 失败/超时置空不阻塞；probe 无 token 直接跳过不计时。
        // README 经 get_with_etag 走 SQLite ETag 缓存（304 命中直接用缓存 payload），
        // 不再每次全量；限流/401 经 get_with_etag 内统一上报，此处补 401 通知。
        let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
        // 瘦身：base_headers 各派生只 clone 一次，后续经 &复用（release/repo/probe 共用 &base_headers，
        // readme 独占 &readme_headers，checksum 独占 &headers），避免双 clone。
        let mut readme_headers = base_headers.clone();
        readme_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3.raw"),
        );
        // README ETag 预读（force 时跳过；冷启动预读为 None）。
        let (readme_etag, readme_payload) = cached_etag_payload(&readme_url, is_force_like);
        // 瘦身：去 default_readme_clone 中间克隆，分支按需 clone &default_readme，避免双 clone。
        let default_readme = format!("# {}\n\n{}", name, desc);
        // probe 分支取值与原图标决策一致，仅前移以便并发（repo_info 已与 release 并发就绪）。
        let probe_branch: String = repo_info
            .as_ref()
            .and_then(|r| r.default_branch.clone())
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "HEAD".to_string());
        // 无 token 直接跳过探测，不计时、不耗配额；有 token 才进 SimpleIcons+Trees。
        let has_token = token.map(|t| !t.trim().is_empty()).unwrap_or(false);
        // 消极缓存判定前移，供 checksum 并发分支使用。
        // H8：时间戳经 github 内 now_secs()。
        let now_secs = crate::github::http::now_secs();
        let negative_hit =
            checksum_negative_hit(cached_detail.as_ref(), version_changed, now_secs);
        // 三路并发：readme 文本、图标探测、校验和抓取同时在途，超时各自内部收敛。
        let (raw_readme, probed_hit, checksums) = tokio::join!(
            fetch_readme_markdown(ReadmeFetch {
                client,
                url: &readme_url,
                headers: &readme_headers,
                etag: readme_etag.as_deref(),
                payload: readme_payload.as_ref(),
                version_changed,
                has_cached_readme,
                cached_readme: cached_readme.as_ref(),
                default_readme: &default_readme,
                log_id: id,
            }),
            probe_repo_icon(client, &base_headers, &owner, &repo, &probe_branch, has_token),
            fetch_checksum_table(
                &release_resp.assets,
                client,
                &headers,
                id,
                &sid,
                &req_id,
                negative_hit
            )
        );
        if let Some(ref p) = probed_hit {
            log::debug!(
                "icon probe hit id={} source={} url='{}'",
                id,
                p.source,
                crate::log_support::sanitize_url(&p.url)
            );
        }
        let probed_url: Option<String> = probed_hit.map(|p| p.url);

        // 动态回写更新内存中的 CatalogItem 统计数据，使得列表页卡片上的 Stars/Forks/Version 也同步刷新
        //（统计取值经 `resolve_detail_stats` 内部 seam：repo 真值优先，缺失回退收录库）。
        let DetailStats {
            stars: latest_stars,
            forks: latest_forks,
            license: latest_license,
            homepage: latest_homepage,
        } = resolve_detail_stats(repo_info.as_ref(), catalog_item.as_ref());

        // 动态回写更新内存中的 CatalogItem 统计数据，使得列表页卡片上的 Stars/Forks/Version 也同步刷新
        let start_stats = std::time::Instant::now();
        self.update_catalog_item_stats(
            id,
            Some(latest_stars),
            Some(latest_forks),
            Some(&release_resp.tag_name),
        );
        log::debug!(
            "catalog stats update done id={} sid={} req={} elapsed_ms={}",
            id,
            sid,
            req_id,
            start_stats.elapsed().as_millis()
        );

        // 提取 README 首部 Logo，并从 README 原始内容中清洗删除该旧图标，避免详情页头部与文档内容区发生重叠/重复
        let chars_in = raw_readme.chars().count();
        log::debug!(
            "readme_process start id={} sid={} req={} chars_in={}",
            id,
            sid,
            req_id,
            chars_in
        );
        let start_readme_process = std::time::Instant::now();
        let (extracted_logo, cleaned_readme) =
            Self::extract_and_strip_logo_from_readme(&raw_readme, &owner, &repo);
        let readme_markdown = Self::rewrite_readme_images(&cleaned_readme, &owner, &repo);
        log::debug!(
            "readme_process done id={} sid={} req={} chars_in={} chars_out={} elapsed_ms={}",
            id,
            sid,
            req_id,
            chars_in,
            readme_markdown.chars().count(),
            start_readme_process.elapsed().as_millis()
        );

        // checksums 已与 readme/probe 三路并发就绪（见上游 join），此处直接复用。
        // 跳过/超时均以空表落库，sha256 缺失由调用方降级。
        // 消极缓存说明见上游 negative_hit 定义处。
        // 资产组装经 `build_release_assets` 内部 seam（过滤→classify→sha→打分排序）。
        let releases = build_release_assets(release_resp.assets, &checksums);

        // 从经校验的有效发布资产中推断平台；无有效安装包则置空，避免虚假发布
        // deduce + ios 并集 + 排序经内部平台 seam（与 304 快径共用）。
        let final_platforms = unioned_detail_platforms(&releases, catalog_item.as_ref());

        // 图标层级决策经 db::icon_cycle::pick_detail_icon（收录官方 → 品牌库 → Trees → README → 空）：
        // 1. 已具备已知独立官方图标则保持，避免被误覆盖；
        // 2. 否则进入探测链（Simple Icons → Git Trees 全库评分）；
        // 3. 探测未命中则采用 README 提取并清洗出的 Logo；
        // 4. 全未命中兜底返回空字符串（前端降级为首字母徽章）。
        let final_icon = if icon.starts_with("http://") || icon.starts_with("https://") {
            icon
        } else {
            // probe 已与 readme/checksums 三路并发完成，此处直接复用 probed_url。
            crate::db::icon_cycle::pick_detail_icon(&icon, probed_url, extracted_logo)
        };

        // B1：趋势榜详情简介丢弃根治——未收录仓 external_synth 占位回填 GitHub 真简介。
        // 已收录仓（catalog_item.is_some()）人工精校简介优先，不覆盖 desc / description_en。
        // 仅当 catalog 未命中且 desc 为占位、repo_info.description 有非空真值时替换；
        // description_en 缺失或占位时同理用 repo 真值回填。
        // 简介决议经 `resolve_effective_descriptions` 内部 seam。
        let (effective_desc, effective_description_en) =
            resolve_effective_descriptions(catalog_item.as_ref(), desc, repo_info.as_ref());

        let detail = AppDetail {
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
            changelog: release_resp.body.unwrap_or_default(),
            is_verified: catalog_item
                .as_ref()
                .map(|i| i.is_verified)
                .unwrap_or(false),
            readme_markdown,
            // 变体复用：版本未变时沿用缓存详情中的 variants，避免清零已回填的多语言正文；
            // 版本变化时置空，待 get_readme_variants 按需重拉（不改 API 形状）。
            readme_variants: if version_changed {
                None
            } else {
                cached_detail
                    .as_ref()
                    .and_then(|c| c.readme_variants.clone())
                    .filter(|v| !v.is_empty())
            },
            releases,
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
            cached_at: Some(crate::github::http::now_secs()),
            // P0：合成空失败（401/限流/离线且无任何缓存）以 stale 区分于成功空。
            // 成功 deduce 路径（releases/platforms 推导、排序、ios 并集）保持不变；
            // 仅此处标记，前端 stale-empty 视为 loading/待 backfill-loading，永不确认 Other，
            // 调用方（commands/catalog）据此跳过 SQLite 持久化。
            // 真空契约：远端 200 已问到（repo/release 任一 Fresh 即走成功路径）、
            // 仅 is_valid_installer_asset 全过滤致 releases/platforms 双空时，
            // synthesized_empty_failure 为 false，此处保持 None（与失败空可区分）；
            // 前端双空+None 视为确认真空（virtual-Other）灭黄标。
            // 仅网络/401/限流/解析失败才标 Some(true)。
            is_stale: if synthesized_empty_failure {
                Some(true)
            } else {
                None
            },
            homepage: latest_homepage,
            platforms: final_platforms,
        };

        Ok((detail, new_cache))
    }

    /// Checksum Manifest〈校验清单〉拉取 adapter（fetch→verify 契约的 fetch 侧；
    /// 服务 ADR-0004，不重开）：3s 硬超时抓取，失败置空不阻塞；
    /// 命中表供流式校验 implementation（`persist_stream_to_file` Tampered 销毁）消费；
    /// 缺失时给空表，下游归 `completed_unverified`。
    /// 平台过滤经 `detail_assets::checksum_asset_platform_eligible` 单口。
    async fn extract_checksums_map(
        assets: &[GitHubAssetResponse],
        client: &reqwest::Client,
        headers: &HeaderMap,
        app_id: &str,
        sid: &str,
        req_id: &str,
    ) -> HashMap<String, String> {
        let start = std::time::Instant::now();
        log::debug!(
            "checksum start id={} sid={} req={} assets={}",
            app_id,
            sid,
            req_id,
            assets.len()
        );
        let mut map = HashMap::new();
        // 平台过滤：仅当 checksum 文件名暗示 Windows 相关（msi/exe/zip/setup/portable/win）
        // 或为通用文件（checksum/sha256 命名且不带 linux/mac/dmg/appimage/deb/rpm/aarch64 等）
        // 时才发起请求；Linux-aarch64-only 文件直接跳过，不产生任何网络请求。
        let mut first_ineligible: Option<(String, &'static str)> = None;
        let mut candidate: Option<&GitHubAssetResponse> = None;
        for a in assets {
            let n = a.name.to_lowercase();
            if !(n.contains("checksum") || n.contains("sha256") || n.ends_with(".sha256")) {
                continue;
            }
            let (eligible, reason) =
                super::detail_assets::checksum_asset_platform_eligible(&n);
            if eligible {
                candidate = Some(a);
                break;
            } else if first_ineligible.is_none() {
                first_ineligible = Some((a.name.clone(), reason));
            }
        }

        let Some(asset) = candidate else {
            let reason = first_ineligible
                .map(|(f, r)| format!("platform_filtered file='{}' hint={}", f, r))
                .unwrap_or_else(|| "no_checksum_asset".to_string());
            log::debug!(
                "checksum skip id={} sid={} req={} reason={} assets={} elapsed_ms={}",
                app_id,
                sid,
                req_id,
                reason,
                assets.len(),
                start.elapsed().as_millis()
            );
            return map;
        };
        // 仅记文件名 + 字节数 + 脱敏 URL/host，永不记 body/hash 值。
        let file_name = asset.name.clone();
        let file_bytes = asset.size;
        // 用原 URL 抓取（失败置空不阻塞）。
        let effective_url = asset.browser_download_url.clone();
        let safe_url = crate::log_support::sanitize_url(&asset.browser_download_url);
        let host = crate::log_support::host_of(&effective_url);
        log::debug!(
            "checksum fetch start id={} sid={} req={} file='{}' bytes={} url='{}' mirror=false",
            app_id,
            sid,
            req_id,
            file_name,
            file_bytes,
            safe_url,
        );
        // 3s 硬超时：checksum 为尽力填充，绝不允许 10s 级阻塞首屏。
        let checksum_timeout = std::time::Duration::from_secs(3);
        let send_fut = client.get(&effective_url).headers(headers.clone()).send();
        let res = match tokio::time::timeout(checksum_timeout, send_fut).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                log::debug!(
                    "checksum fail id={} sid={} req={} file='{}' host={} reason={} elapsed_ms={}",
                    app_id,
                    sid,
                    req_id,
                    file_name,
                    host,
                    crate::log_support::short_reason(&e.to_string()),
                    start.elapsed().as_millis()
                );
                return map;
            }
            Err(_) => {
                log::debug!(
                    "checksum fail id={} sid={} req={} file='{}' host={} reason=checksum_timeout_3s elapsed_ms={}",
                    app_id,
                    sid,
                    req_id,
                    file_name,
                    host,
                    start.elapsed().as_millis()
                );
                return map;
            }
        };
        let status = res.status().as_u16();
        if !res.status().is_success() {
            log::debug!(
                "checksum fail id={} sid={} req={} file='{}' host={} status={} elapsed_ms={}",
                app_id,
                sid,
                req_id,
                file_name,
                host,
                status,
                start.elapsed().as_millis()
            );
            return map;
        }
        let text = match tokio::time::timeout(checksum_timeout, res.text()).await {
            Ok(Ok(t)) => t,
            _ => {
                log::debug!(
                    "checksum fail id={} sid={} req={} file='{}' host={} reason=read_body_failed_or_timeout elapsed_ms={}",
                    app_id,
                    sid,
                    req_id,
                    file_name,
                    host,
                    start.elapsed().as_millis()
                );
                return map;
            }
        };
        for line in text.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let hash = parts[0].trim();
                let filename = parts[1].trim().trim_start_matches('*');
                if hash.len() == 64 {
                    map.insert(filename.to_string(), hash.to_lowercase());
                }
            }
        }
        log::debug!(
            "checksum done id={} sid={} req={} file='{}' host={} entries={} elapsed_ms={}",
            app_id,
            sid,
            req_id,
            file_name,
            host,
            map.len(),
            start.elapsed().as_millis()
        );
        map
    }
}

#[cfg(test)]
mod tests {
    use super::CatalogService;

    #[tokio::test]
    async fn test_checksum_manifest_fetch_via_unified_interface_degrades_to_empty() {
        // 校验拉取（3s 硬超时，失败置空）：不可达 hostile 对端时返回空表，
        // 不阻塞详情、不 panic。
        // 平台过滤断言见 `detail_assets` 单源覆盖，此处只锁置空行为。
        let assets = vec![crate::github::models::GitHubAssetResponse {
            name: "x.sha256".to_string(),
            size: 100,
            browser_download_url: "http://127.0.0.1:9/x.sha256".to_string(),
        }];
        let client = reqwest::Client::new();
        let headers = reqwest::header::HeaderMap::new();
        let map = CatalogService::extract_checksums_map(
            &assets,
            &client,
            &headers,
            "t/t",
            "sid",
            "req",
        )
        .await;
        assert!(map.is_empty());
    }

    #[test]
    fn test_is_placeholder_description_covers_known_cases() {
        assert!(super::is_placeholder_description(""));
        assert!(super::is_placeholder_description("   "));
        assert!(super::is_placeholder_description("GitHub 社区开源项目"));
        assert!(super::is_placeholder_description("跨平台开源项目（extra）"));
        assert!(!super::is_placeholder_description("Real repo description"));
        assert!(!super::is_placeholder_description("树莓派工具"));
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
}
