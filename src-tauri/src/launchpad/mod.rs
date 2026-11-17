//! 开源广场（Launchpad）清单解析、置顶实时分流与无凭据拉取。
//!
//! 清单与精选目录物理隔离：本模块只读写 `launchpad_feed_cache` / `api_etag_cache`
//! 与未收录 `repo_card_cache`，永不触碰 `catalog_apps` / `custom_apps`。

pub mod models;

pub use models::{
    LaunchpadDiscussionAuthor, LaunchpadDiscussionComment, LaunchpadDiscussionDetail,
    LaunchpadEntry, LaunchpadFeedResponse, LaunchpadMaker, LaunchpadPulseItem,
    LaunchpadReactionGroup, LaunchpadUpvoteResult, LaunchpadVoteMode, RawLaunchpadItem,
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
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| fail(format!("读取开源广场清单失败: {}", e), true))?;
    if bytes.len() > crate::db::launchpad::LAUNCHPAD_FEED_CACHE_MAX_BYTES {
        return Err(fail("开源广场清单超过 512 KiB 上限".to_string(), false));
    }
    let text = String::from_utf8(bytes.to_vec())
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
    let primary_err = match fetch_once(primary, url, cached_etag).await {
        Ok(f) => return Ok(f),
        Err(e) if e.retryable => e.message,
        Err(e) => return Err(e.message),
    };
    let Some(prefix) = mirror_prefix else {
        return Err(primary_err);
    };
    let mirrored = crate::mirror::prefix_with_base(prefix, url);
    let client = crate::github::CatalogService::build_catalog_client(
        &crate::proxy::current_proxy_snapshot(),
        &crate::proxy::proxy_hosts_for(&mirrored),
    )?;
    let fetched = fetch_once(&client, &mirrored, None)
        .await
        .map_err(|e| format!("{}；镜像重试失败: {}", primary_err, e.message))?;
    let Some(text) = fetched.text else {
        return Err(format!("{}；镜像未发条件请求却返回 304", primary_err));
    };
    let manifest = parse_manifest(&text)
        .map_err(|reason| format!("{}；镜像清单校验失败: {}", primary_err, reason))?;
    validate_manifest_strict(&manifest)
        .map_err(|reason| format!("{}；镜像清单校验失败: {}", primary_err, reason))?;
    Ok(LaunchpadFetch {
        text: Some(text),
        etag: None,
        via_mirror: true,
    })
}

#[cfg(test)]
mod tests;
