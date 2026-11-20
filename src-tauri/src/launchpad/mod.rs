//! 开源广场（Launchpad）清单解析与无凭据拉取，数据独立存于广场缓存表，不写入收录目录。

pub mod models;

pub use models::{
    LaunchpadDiscussionAuthor, LaunchpadDiscussionComment, LaunchpadDiscussionDetail,
    LaunchpadEntry, LaunchpadFeedResponse, LaunchpadMaker, LaunchpadPreflightResult,
    LaunchpadPulseItem, LaunchpadReactionGroup, LaunchpadUpvoteResult, LaunchpadVoteMode,
    PreflightCheckItem, PreflightCheckKey, PreflightCheckStatus, RawLaunchpadItem,
    RawLaunchpadManifest, RawLaunchpadPin,
};

use models::non_empty;
use reqwest::header::{IF_NONE_MATCH, USER_AGENT};
use std::collections::{HashMap, HashSet};

/// 顶部置顶推荐坑位硬上限。
pub const SPOTLIGHT_MAX_SLOTS: usize = 4;
/// 唯一支持的清单版本。
pub const LAUNCHPAD_MANIFEST_VERSION: u32 = 1;
/// 五端平台枚举（其余值丢弃）。
const KNOWN_PLATFORMS: [&str; 5] = ["windows", "macos", "linux", "android", "ios"];

/// 图标/头像只接受 `https://`（或空串）；`data:` 与其他协议一律剥空。
pub(crate) fn sanitize_icon(raw: &str) -> String {
    let t = raw.trim();
    let is_https = t
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
    if is_https && t.len() > 8 {
        t.to_string()
    } else {
        String::new()
    }
}

pub(crate) fn normalize_platforms(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in raw {
        let p = p.trim().to_lowercase();
        if KNOWN_PLATFORMS.contains(&p.as_str()) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// RFC3339 时间戳转 Unix 秒；无法解析返回 `None`。
pub(crate) fn parse_rfc3339_secs(raw: &str) -> Option<i64> {
    time::OffsetDateTime::parse(raw.trim(), &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|t| t.unix_timestamp())
}

/// 广场条目规范标识：在 `canonical_app_id` 之上额外拒绝 `.` / `..` 路径段。
pub(crate) fn canonical_id(raw: &str) -> Option<String> {
    let id = crate::forge::canonical_app_id(raw)?;
    let coord = id.rsplit(':').next().unwrap_or(&id);
    let ok = coord
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    ok.then_some(id)
}

/// 解析清单文本：版本不符或 JSON 非法返回 `Err`（整页降级），单条脏数据由分流阶段跳过。
pub fn parse_manifest(text: &str) -> Result<RawLaunchpadManifest, String> {
    let manifest: RawLaunchpadManifest =
        serde_json::from_str(text).map_err(|e| format!("解析开源广场清单 JSON 失败: {}", e))?;
    if manifest.version != LAUNCHPAD_MANIFEST_VERSION {
        return Err(format!("不支持的开源广场清单版本: {}", manifest.version));
    }
    Ok(manifest)
}

/// 镜像响应严格校验：每条 `id` 必须是合法规范标识，`pinned` 引用必须存在。
pub fn validate_manifest_strict(manifest: &RawLaunchpadManifest) -> Result<(), String> {
    let mut ids = HashSet::new();
    for item in &manifest.items {
        let Some(id) = canonical_id(&item.id) else {
            return Err(format!(
                "清单含非法应用标识: {}",
                crate::log_support::short_reason(&item.id)
            ));
        };
        ids.insert(id);
    }
    for pin in &manifest.pinned {
        let ok = canonical_id(&pin.id).is_some_and(|id| ids.contains(&id));
        if !ok {
            return Err(format!(
                "置顶引用不存在的应用: {}",
                crate::log_support::short_reason(&pin.id)
            ));
        }
    }
    Ok(())
}

fn admit_unique_id(seen: &mut HashSet<String>, raw_id: &str) -> Option<String> {
    let Some(id) = canonical_id(raw_id) else {
        log::debug!(
            target: "launchpad",
            "skip invalid id: {}",
            crate::log_support::short_reason(raw_id)
        );
        return None;
    };
    if !seen.insert(id.clone()) {
        log::debug!(target: "launchpad", "skip duplicate id: {}", id);
        return None;
    }
    Some(id)
}

/// 规整清单：`id` 归一、剥离 `data:` 图标、丢弃非法与重复条目，返回可安全落盘的副本。
pub fn sanitize_manifest(mut manifest: RawLaunchpadManifest) -> RawLaunchpadManifest {
    let mut seen = HashSet::new();
    manifest.items.retain_mut(|item| {
        let Some(id) = admit_unique_id(&mut seen, &item.id) else {
            return false;
        };
        item.id = id;
        item.icon = sanitize_icon(&item.icon);
        item.maker.avatar_url = sanitize_icon(&item.maker.avatar_url);
        true
    });
    manifest
}

/// 置顶实时分流：未过期（`pin_until > now_secs`）且存在于 `items` 的置顶按 `(pin_order, id)`
/// 取前 `SPOTLIGHT_MAX_SLOTS` 条进 `spotlight`；过期、溢出与普通条目统一进 `items`
/// （保持清单原序），整页同一 `id` 只出现一次。
pub fn partition_spotlight_and_recent(
    manifest: &RawLaunchpadManifest,
    now_secs: i64,
) -> (Vec<LaunchpadEntry>, Vec<LaunchpadEntry>) {
    let mut seen = HashSet::new();
    let mut by_id: HashMap<String, &RawLaunchpadItem> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for item in &manifest.items {
        let Some(id) = admit_unique_id(&mut seen, &item.id) else {
            continue;
        };
        by_id.insert(id.clone(), item);
        order.push(id);
    }

    let mut active: Vec<(u32, String, &RawLaunchpadPin)> = Vec::new();
    let mut pinned_seen = HashSet::new();
    for pin in &manifest.pinned {
        let Some(id) = canonical_id(&pin.id) else {
            continue;
        };
        if !by_id.contains_key(&id) || !pinned_seen.insert(id.clone()) {
            continue;
        }
        if parse_rfc3339_secs(&pin.pin_until).is_some_and(|until| until > now_secs) {
            active.push((pin.pin_order, id, pin));
        }
    }
    active.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    active.truncate(SPOTLIGHT_MAX_SLOTS);

    let spotlight_ids: HashSet<&String> = active.iter().map(|(_, id, _)| id).collect();
    let spotlight: Vec<LaunchpadEntry> = active
        .iter()
        .map(|(_, id, pin)| {
            let mut entry = item_to_entry(by_id[id], id);
            entry.is_pinned = true;
            entry.pin_until = Some(pin.pin_until.trim().to_string());
            let tier = pin.pin_tier.trim();
            entry.pin_tier = (!tier.is_empty()).then(|| tier.to_string());
            entry
        })
        .collect();
    let items = order
        .iter()
        .filter(|id| !spotlight_ids.contains(id))
        .map(|id| item_to_entry(by_id[id], id))
        .collect();
    (spotlight, items)
}

fn item_to_entry(item: &RawLaunchpadItem, id: &str) -> LaunchpadEntry {
    let summary = item.to_summary(id);
    let discussion_repo = item.discussion_repo.trim().to_string();
    let discussion_url = if item.discussion_url.trim().is_empty()
        && !discussion_repo.is_empty()
        && item.discussion_number > 0
    {
        format!(
            "https://github.com/{}/discussions/{}",
            discussion_repo, item.discussion_number
        )
    } else {
        item.discussion_url.trim().to_string()
    };
    let maker_note = item
        .maker_note
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    LaunchpadEntry {
        summary,
        maker_note,
        maker_note_en: non_empty(&item.maker_note_en),
        maker: LaunchpadMaker {
            login: item.maker.login.trim().to_string(),
            name: non_empty(&item.maker.name),
            avatar_url: sanitize_icon(&item.maker.avatar_url),
            html_url: item.maker.html_url.trim().to_string(),
        },
        launched_at: item.launched_at.trim().to_string(),
        latest_release_at: non_empty(&item.latest_release_at),
        stars_7d_delta: item.stars_7d_delta.max(0),
        discussion_repo,
        discussion_number: item.discussion_number,
        discussion_node_id: non_empty(&item.discussion_node_id),
        discussion_url,
        discussion_comments_count: item.discussion_comments_count,
        discussion_upvotes: item.discussion_upvotes,
        is_pinned: false,
        pin_until: None,
        pin_tier: None,
        viewer_has_starred: false,
        viewer_has_upvoted: false,
    }
}

/// 一次拉取结果：`text == None` 表示 `304 Not Modified`。
#[derive(Debug)]
pub struct LaunchpadFetch {
    pub text: Option<String>,
    pub etag: Option<String>,
    pub via_mirror: bool,
}

#[derive(Debug)]
pub struct LaunchpadFetchError {
    pub message: String,
    /// 传输失败 / 429 / 5xx：官方默认源可经镜像重试。
    pub retryable: bool,
}

/// 单跳拉取（无 Token）：响应超过快照上限视为不可重试失败。
pub async fn fetch_once(
    client: &reqwest::Client,
    url: &str,
    cached_etag: Option<&str>,
) -> Result<LaunchpadFetch, LaunchpadFetchError> {
    let fail = |message: String, retryable: bool| LaunchpadFetchError { message, retryable };
    let mut req = client
        .get(url)
        .header(USER_AGENT, crate::github::http::GH_USER_AGENT);
    if let Some(etag) = cached_etag {
        req = req.header(IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| {
        crate::proxy::note_transport_error(&e);
        fail(format!("请求开源广场清单失败: {}", e), true)
    })?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(LaunchpadFetch {
            text: None,
            etag: None,
            via_mirror: false,
        });
    }
    if !status.is_success() {
        let retryable = status.as_u16() == 429 || status.is_server_error();
        return Err(fail(
            format!("同步开源广场清单失败，HTTP 状态码: {}", status),
            retryable,
        ));
    }
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());
    let bytes = crate::forge::http::read_body_capped(
        resp,
        crate::db::launchpad::LAUNCHPAD_FEED_CACHE_MAX_BYTES,
    )
    .await
    .map_err(|e| match e {
        crate::forge::http::BodyReadError::TooLarge => {
            fail("开源广场清单超过 512 KiB 上限".to_string(), false)
        }
        crate::forge::http::BodyReadError::Transport(e) => {
            fail(format!("读取开源广场清单失败: {}", e), true)
        }
    })?;
    let text = String::from_utf8(bytes)
        .map_err(|_| fail("开源广场清单不是合法 UTF-8".to_string(), false))?;
    Ok(LaunchpadFetch {
        text: Some(text),
        etag,
        via_mirror: false,
    })
}

/// 首跳经 `primary`（无 Token 清单池）；可重试失败且给出 `mirror_prefix` 时经镜像重试一次
/// （不发条件请求，响应须通过版本与全量规范标识严格校验）。
pub async fn fetch_with_fallback(
    primary: &reqwest::Client,
    url: &str,
    cached_etag: Option<&str>,
    mirror_prefix: Option<&str>,
) -> Result<LaunchpadFetch, String> {
    let first = async {
        fetch_once(primary, url, cached_etag).await.map_err(|e| {
            crate::github::catalog_service::MirrorPrimaryError {
                message: e.message,
                retryable: e.retryable,
            }
        })
    };
    crate::github::catalog_service::fetch_with_mirror_fallback(
        first,
        url,
        mirror_prefix,
        |client, mirrored| async move {
            let fetched = fetch_once(&client, &mirrored, None)
                .await
                .map_err(|e| format!("镜像重试失败: {}", e.message))?;
            let Some(text) = fetched.text else {
                return Err("镜像未发条件请求却返回 304".to_string());
            };
            let manifest =
                parse_manifest(&text).map_err(|reason| format!("镜像清单校验失败: {}", reason))?;
            validate_manifest_strict(&manifest)
                .map_err(|reason| format!("镜像清单校验失败: {}", reason))?;
            Ok(LaunchpadFetch {
                text: Some(text),
                etag: None,
                via_mirror: true,
            })
        },
    )
    .await
}

/// 解析投稿输入坐标（支持 `owner/repo`、`@owner/repo`、短前缀或完整 Forge URL）。
pub fn parse_preflight_coord(repo_url: &str) -> Option<(crate::forge::UniversalRepoCoord, String)> {
    let trimmed = repo_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = if trimmed.starts_with('@') && !trimmed.contains("://") && !trimmed.contains(':') {
        trimmed.trim_start_matches('@').trim()
    } else {
        trimmed
    };
    let coord = crate::forge::RepositoryUrlParser::parse(normalized)?;
    let canon = canonical_id(&coord.to_app_id())?;
    Some((coord, canon))
}

/// 无法解析仓库坐标时的固定预检失败响应。
pub fn invalid_coord_preflight_result(raw_input: &str) -> LaunchpadPreflightResult {
    let trimmed = raw_input.trim();
    let detail = if trimmed.is_empty() {
        "请输入公开仓库地址或 owner/repo".to_string()
    } else {
        format!(
            "无法识别仓库地址：{trimmed}（支持 GitHub / Codeberg / Gitea / GitLab 公开仓库）"
        )
    };
    LaunchpadPreflightResult {
        ok: false,
        canonical_id: String::new(),
        forge: String::new(),
        forge_host: String::new(),
        owner: String::new(),
        repo: String::new(),
        repo_name: String::new(),
        description: String::new(),
        homepage: None,
        license: String::new(),
        latest_version: String::new(),
        platforms: Vec::new(),
        installable_asset_count: 0,
        has_checksum_manifest: false,
        resolved_icon_url: String::new(),
        stars: 0,
        forks: 0,
        maker_avatar_url: String::new(),
        already_in_launchpad: false,
        already_in_catalog: false,
        checks: vec![PreflightCheckItem {
            key: PreflightCheckKey::Coord,
            status: PreflightCheckStatus::Fail,
            detail,
        }],
    }
}

/// 校验开源协议是否命中 37 项 OSI SPDX 白名单（经 `normalize_license_token` 归一化）。
pub fn is_osi_allowed_license(raw_license: &str, allowed: &[String]) -> bool {
    let norm = crate::config::normalize_license_token(raw_license);
    if norm.is_empty() || norm == "NOASSERTION" || norm == "NONE" || norm == "UNKNOWN" {
        return false;
    }
    allowed
        .iter()
        .any(|item| crate::config::normalize_license_token(item) == norm)
}

/// 检查 Release 资产中是否包含 SHA-256 校验清单文件。
pub fn has_checksum_manifest_asset(assets: &[crate::models::ReleaseAsset]) -> bool {
    assets.iter().any(|a| {
        let lower = a.name.trim().to_ascii_lowercase();
        !lower.is_empty()
            && (lower.contains("checksum")
                || lower.contains("sha256")
                || lower.ends_with(".sha256"))
    })
}

/// 图标预检探测结果（与网络层解耦，供纯函数决议汇总）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightIconOutcome {
    CustomValid(String),
    CustomInvalidScheme(String),
    CustomUnreachableFallback(Option<String>),
    AutoProbed(Option<String>),
}

/// `evaluate_launchpad_preflight` 的纯输入上下文，封装各步探测到的元数据。
pub struct LaunchpadPreflightInput<'a> {
    pub coord: &'a crate::forge::UniversalRepoCoord,
    pub canonical_id: &'a str,
    pub already_in_launchpad: bool,
    pub already_in_catalog: bool,
    pub repo_res: Result<&'a crate::forge::ForgeRepoInfo, &'a str>,
    pub release_res: Result<&'a crate::forge::ForgeReleaseInfo, &'a str>,
    pub icon_outcome: PreflightIconOutcome,
    pub allowed_licenses: &'a [String],
}

/// 汇总仓库信息、OSI 协议、Release 产物与图标探测结果，输出投稿预检结构。
pub fn evaluate_launchpad_preflight(
    input: LaunchpadPreflightInput<'_>,
) -> LaunchpadPreflightResult {
    let LaunchpadPreflightInput {
        coord,
        canonical_id,
        already_in_launchpad,
        already_in_catalog,
        repo_res,
        release_res,
        icon_outcome,
        allowed_licenses,
    } = input;
    let mut ok = true;
    let mut checks = Vec::with_capacity(5);

    match repo_res {
        Ok(_) => checks.push(PreflightCheckItem {
            key: PreflightCheckKey::Coord,
            status: PreflightCheckStatus::Pass,
            detail: format!("仓库可达：{canonical_id}（{}）", coord.host),
        }),
        Err(err) => {
            ok = false;
            checks.push(PreflightCheckItem {
                key: PreflightCheckKey::Coord,
                status: PreflightCheckStatus::Fail,
                detail: format!("无法访问公开仓库 {canonical_id}：{err}"),
            });
        }
    }

    let dup_item = match (already_in_launchpad, already_in_catalog) {
        (true, true) => PreflightCheckItem {
            key: PreflightCheckKey::Duplicate,
            status: PreflightCheckStatus::Warn,
            detail: "该应用已在精选库与开源广场中，建议确认无需重复提交".to_string(),
        },
        (true, false) => PreflightCheckItem {
            key: PreflightCheckKey::Duplicate,
            status: PreflightCheckStatus::Warn,
            detail: "已在开源广场上架，重复投稿可能会被维护者关闭".to_string(),
        },
        (false, true) => PreflightCheckItem {
            key: PreflightCheckKey::Duplicate,
            status: PreflightCheckStatus::Warn,
            detail: "已在精选库，仍可补充开源广场曝光或直接完善目录".to_string(),
        },
        (false, false) => PreflightCheckItem {
            key: PreflightCheckKey::Duplicate,
            status: PreflightCheckStatus::Pass,
            detail: "未在开源广场或精选目录发现重复条目".to_string(),
        },
    };
    checks.push(dup_item);

    let raw_license = repo_res
        .ok()
        .and_then(|r| r.license.as_deref())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if repo_res.is_err() {
        ok = false;
        checks.push(PreflightCheckItem {
            key: PreflightCheckKey::License,
            status: PreflightCheckStatus::Fail,
            detail: "仓库不可达，无法核验开源协议".to_string(),
        });
    } else if is_osi_allowed_license(&raw_license, allowed_licenses) {
        checks.push(PreflightCheckItem {
            key: PreflightCheckKey::License,
            status: PreflightCheckStatus::Pass,
            detail: format!("OSI 开源协议校验通过：{raw_license}"),
        });
    } else {
        ok = false;
        let detail = if raw_license.is_empty() || raw_license.eq_ignore_ascii_case("NOASSERTION") {
            "未检测到明确的 OSI SPDX 协议（缺失 LICENSE 或返回 NOASSERTION）".to_string()
        } else {
            format!("协议 {raw_license} 不在 ZStore 37 项 OSI 白名单内")
        };
        checks.push(PreflightCheckItem {
            key: PreflightCheckKey::License,
            status: PreflightCheckStatus::Fail,
            detail,
        });
    }

    let (latest_version, platforms, installable_asset_count, has_checksum_manifest) =
        match release_res {
            Ok(rel) => {
                let tag = rel.tag_name.trim().to_string();
                let count = rel
                    .assets
                    .iter()
                    .filter(|a| {
                        crate::github::detail_assets::is_valid_installer_asset(
                            &a.name,
                            a.size_bytes,
                        )
                    })
                    .count();
                let plats = crate::github::detail_assets::platforms_from_assets(&rel.assets);
                let has_chk = has_checksum_manifest_asset(&rel.assets);
                if tag.is_empty() || count == 0 || plats.is_empty() {
                    ok = false;
                    checks.push(PreflightCheckItem {
                        key: PreflightCheckKey::Release,
                        status: PreflightCheckStatus::Fail,
                        detail: "最新 Release 缺少 >1 MiB 的可安装二进制资产（纯源码包或占位包不予上架）".to_string(),
                    });
                } else if !has_chk {
                    checks.push(PreflightCheckItem {
                        key: PreflightCheckKey::Release,
                        status: PreflightCheckStatus::Warn,
                        detail: format!(
                            "{tag} 含 {count} 个可安装资产（{}），未检测到 SHA-256 校验清单",
                            plats.join(", ")
                        ),
                    });
                } else {
                    checks.push(PreflightCheckItem {
                        key: PreflightCheckKey::Release,
                        status: PreflightCheckStatus::Pass,
                        detail: format!(
                            "{tag} 含 {count} 个可安装资产（{}）与校验清单",
                            plats.join(", ")
                        ),
                    });
                }
                (tag, plats, count, has_chk)
            }
            Err(err) => {
                ok = false;
                checks.push(PreflightCheckItem {
                    key: PreflightCheckKey::Release,
                    status: PreflightCheckStatus::Fail,
                    detail: format!("未获取到最新 Release：{err}"),
                });
                (String::new(), Vec::new(), 0, false)
            }
        };

    let resolved_icon_url = match icon_outcome {
        PreflightIconOutcome::CustomValid(url) => {
            let clean = sanitize_icon(&url);
            checks.push(PreflightCheckItem {
                key: PreflightCheckKey::Icon,
                status: PreflightCheckStatus::Pass,
                detail: "自定义 https:// 图标首包验图通过".to_string(),
            });
            clean
        }
        PreflightIconOutcome::CustomInvalidScheme(reason) => {
            ok = false;
            checks.push(PreflightCheckItem {
                key: PreflightCheckKey::Icon,
                status: PreflightCheckStatus::Fail,
                detail: reason,
            });
            String::new()
        }
        PreflightIconOutcome::CustomUnreachableFallback(fallback) => {
            let clean = fallback.as_deref().map(sanitize_icon).unwrap_or_default();
            let detail = if clean.is_empty() {
                "自定义图标直链不可用且未探测到仓库图标，将使用默认首字母图标".to_string()
            } else {
                "自定义图标直链不可用或非有效图片，已回落自动探测图标".to_string()
            };
            checks.push(PreflightCheckItem {
                key: PreflightCheckKey::Icon,
                status: PreflightCheckStatus::Warn,
                detail,
            });
            clean
        }
        PreflightIconOutcome::AutoProbed(probed) => {
            let clean = probed.as_deref().map(sanitize_icon).unwrap_or_default();
            if clean.is_empty() {
                checks.push(PreflightCheckItem {
                    key: PreflightCheckKey::Icon,
                    status: PreflightCheckStatus::Warn,
                    detail: "将使用默认首字母图标，建议补充图标直链或仓库 logo".to_string(),
                });
            } else {
                checks.push(PreflightCheckItem {
                    key: PreflightCheckKey::Icon,
                    status: PreflightCheckStatus::Pass,
                    detail: "已自动探测到仓库图标".to_string(),
                });
            }
            clean
        }
    };

    let repo_info = repo_res.ok();
    let repo_name = repo_info
        .map(|r| r.name.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| coord.repo.clone());
    let description = repo_info
        .and_then(|r| r.description.as_deref())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let homepage = repo_info
        .and_then(|r| r.homepage.as_deref())
        .map(str::trim)
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .map(str::to_string);
    let maker_avatar_url = repo_info
        .and_then(|r| r.owner_avatar_url.as_deref())
        .map(sanitize_icon)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if coord.forge == crate::forge::ForgeType::GitHub {
                format!("https://github.com/{}.png", urlencoding::encode(&coord.owner))
            } else {
                String::new()
            }
        });

    LaunchpadPreflightResult {
        ok,
        canonical_id: canonical_id.to_string(),
        forge: coord.forge.as_str().to_string(),
        forge_host: coord.host.clone(),
        owner: coord.owner.clone(),
        repo: coord.repo.clone(),
        repo_name,
        description,
        homepage,
        license: raw_license,
        latest_version,
        platforms,
        installable_asset_count,
        has_checksum_manifest,
        resolved_icon_url,
        stars: repo_info.map(|r| r.stars).unwrap_or(0),
        forks: repo_info.map(|r| r.forks).unwrap_or(0),
        maker_avatar_url,
        already_in_launchpad,
        already_in_catalog,
        checks,
    }
}

#[cfg(test)]
mod tests;
