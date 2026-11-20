//! 图标探测原语：SimpleIcons 品牌库与 Git Trees 全库评分，负责查找 URL 并校验字节。

use reqwest::header::HeaderMap;
use serde::Deserialize;

/// 探测命中结果（SimpleIcons CDN 或 `raw.githubusercontent.com` URL）。
pub(crate) struct ProbedIcon {
    pub url: String,
    pub source: &'static str,
}

/// 由仓库名派生 Simple Icons slug 候选（小写去分隔符优先，保留原样其次）。
pub(crate) fn derive_slugs(repo: &str) -> Vec<String> {
    let lower = repo.trim().to_lowercase();
    let stripped: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    // 纯符号名无法派生有效 slug。
    if stripped.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(2);
    if !stripped.is_empty() {
        out.push(stripped);
    }
    if !lower.is_empty() && lower != out.first().map(String::as_str).unwrap_or("") {
        out.push(lower);
    }
    out
}

/// README 正文插图关键词表（用于 `is_readme_body_image` 按文件名 stem 精确排除）。
pub(crate) const BODY_IMAGE_KEYWORDS: &[&str] = &[
    "screenshot",
    "preview",
    "banner",
    "badge",
    "demo",
    "diagram",
    "architecture",
    "cover",
    "workflow",
    "license",
];

/// 判断路径或 URL 是否为 README 正文插图（屏蔽 `shields.io` 及精确匹配的插图文件名，含 `logo`/`icon` 放行）。
pub(crate) fn is_readme_body_image(path_or_url: &str) -> bool {
    let lower_full = path_or_url.to_ascii_lowercase();
    if lower_full.contains("shields.io") {
        return true;
    }
    let trimmed = path_or_url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let no_frag = trimmed.split(['#', '?']).next().unwrap_or(trimmed);
    let path = if let Some(idx) = no_frag.find("://") {
        let after = &no_frag[idx + 3..];
        after.find('/').map(|i| &after[i + 1..]).unwrap_or("")
    } else {
        no_frag
    };
    let filename = path.rsplit('/').next().unwrap_or(path).trim();
    if filename.is_empty() {
        return false;
    }
    let stem = filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(filename)
        .to_ascii_lowercase();
    let stem = stem.trim();
    if stem.is_empty() {
        return false;
    }
    if stem.contains("logo") || stem.contains("icon") {
        return false;
    }
    BODY_IMAGE_KEYWORDS
        .iter()
        .any(|k| *k == stem || (stem.len() == k.len() + 1 && stem.strip_suffix('s') == Some(*k)))
}

/// 启发式评分仓库文件是否为应用主图标（非 png/svg/ico 返回 -100，正分才采用）。
pub(crate) fn score_candidate(file_path: &str, size: Option<u64>, repo: &str) -> i32 {
    let lower = file_path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if ext != "png" && ext != "svg" && ext != "ico" {
        return -100;
    }
    if lower.contains("node_modules/")
        || lower.contains("vendor/")
        || lower.contains("tests/")
        || lower.contains("test/")
        || lower.contains(".github/")
        || lower.contains("dist/")
        || lower.contains("target/")
        || lower.contains("ui-lightness")
        || lower.contains("jquery")
    {
        return -100;
    }
    if is_readme_body_image(file_path) {
        return -50;
    }
    if lower.contains("aprilfools") || lower.contains("xmas") || lower.contains("christmas") {
        return -30;
    }
    // 排除 Git LFS 指针文本文件（~130 字节）。
    if size.is_some_and(|s| s < MIN_IMAGE_BYTES as u64) {
        return -100;
    }

    let mut score = 0i32;
    let filename = lower.rsplit('/').next().unwrap_or(&lower);
    let clean_repo: String = repo
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    // 1. 文件名核心匹配。
    if [
        "icon.png",
        "app-icon.png",
        "app_icon.png",
        "logo.png",
        "applogo.png",
    ]
    .contains(&filename)
    {
        score += 100;
    } else if ["icon.svg", "logo.svg", "app-icon.svg", "app_icon.svg"].contains(&filename) {
        score += 95;
    } else if !clean_repo.is_empty()
        && (filename == format!("{clean_repo}.png") || filename == format!("{clean_repo}.svg"))
    {
        score += 90;
    } else if ["icon.ico", "app.ico", "logo.ico", "7ziplogo.ico"].contains(&filename) {
        score += 70;
    } else if filename.contains("icon") || filename.contains("logo") {
        score += 50;
    }

    // 压低单色/线框 UI 字形分数，避免误选为应用主图标。
    if lower.contains("monochrome") || lower.contains("symbolic") {
        score -= 40;
    }
    if filename.contains("-line") {
        score -= 30;
    }

    if lower.contains("512")
        || lower.contains("large")
        || lower.contains("hi-res")
        || lower.contains("hires")
        || lower.contains("1024")
    {
        score += 40;
    } else if lower.contains("256") {
        score += 30;
    } else if lower.contains("128") {
        score += 20;
    } else if lower.contains("64") {
        score += 10;
    } else if lower.contains("32") {
        score += 5;
    } else if lower.contains("16") {
        score -= 20;
    }

    if lower.starts_with("res/")
        || lower.starts_with("assets/")
        || lower.starts_with("resources/")
        || lower.starts_with("media/")
        || lower.starts_with("public/")
    {
        score += 25;
    }
    if lower.contains("/app/")
        || lower.contains("/icon/")
        || lower.contains("/icons/")
        || lower.contains("src-tauri/icons")
    {
        score += 20;
    }
    if lower.contains("desktop")
        || lower.contains("packaging")
        || lower.contains("gtk/icons")
        || lower.contains("extra/logo")
    {
        score += 15;
    }

    score
}

fn raw_url(owner: &str, repo: &str, branch: &str, file_path: &str) -> String {
    // branch 整体编码以保留含 `/` 的分支名，file_path 按段编码以保留路径分隔符。
    let encoded_path = file_path
        .trim_start_matches('/')
        .split('/')
        .map(urlencoding::encode)
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
        urlencoding::encode(branch),
        encoded_path
    )
}

/// 首包验图上限：Range 首 32KB，避免全量下载大图。
const PROBE_RANGE_BYTES: usize = 32 * 1024;
/// 最小合法图片字节（与 `verifyImageBytes` 同阈值；评分里的 300 同源）。
const MIN_IMAGE_BYTES: usize = 300;

fn content_type_is_image(ctype: &str) -> bool {
    ctype.starts_with("image/") || ctype.contains("octet-stream") || ctype.contains("svg")
}

/// 头部预检：content-type 为图 + 声明长度（若有）≥300B。
/// HEAD / Range / 全量 GET 三处复用，避免分散的 `content_type_is_image + 300` 判断。
fn headers_hit(ctype: &str, len_opt: Option<usize>) -> bool {
    content_type_is_image(ctype) && len_opt.is_none_or(|n| n >= MIN_IMAGE_BYTES)
}

/// 首包 magic 校验：二进制头（png/jpeg/gif/ico/webp/bmp）或 svg 文本头。
/// 未知类型回退为“首包非空即过”，最终仍由 content-type + 长度兜底。
fn magic_is_image(chunk: &[u8], ctype: &str) -> bool {
    if chunk.starts_with(&[0x89, b'P', b'N', b'G']) {
        return true;
    }
    if chunk.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    if chunk.starts_with(b"GIF8") {
        return true;
    }
    if chunk.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return true;
    }
    if chunk.starts_with(b"BM") {
        return true;
    }
    if chunk.len() >= 12 && chunk.starts_with(b"RIFF") && chunk[8..12.min(chunk.len())] == *b"WEBP"
    {
        return true;
    }
    // SVG 是文本：首包内找 `<svg` / `<?xml`（大小写不敏感）。
    let head = String::from_utf8_lossy(&chunk[..chunk.len().min(1024)]).to_lowercase();
    if head.contains("<svg") || head.contains("<?xml") {
        return true;
    }
    // octet-stream 无明确类型时，有可识别二进制头才算过；否则按 ctype 放行
    //（CDN 不返回标准 magic 时走此路，长度阈值仍卡掉 LFS 指针等小文件）。
    !ctype.contains("octet-stream")
}

/// 确定性 HTTP 不存在状态码（404/410），收到后立即短路避免后续 Range/全量请求放大。
pub(crate) fn is_terminal_http_miss(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
    )
}

enum RangeProbeOutcome {
    Verified(Option<(usize, String)>),
    NeedFallback,
}

/// 校验远程 URL 是否为有效图片（≥300B），依次尝试 HEAD、Range 首 32KB、全量 GET。
async fn verify_image(
    client: &reqwest::Client,
    url: &str,
    timeout: std::time::Duration,
) -> Option<(usize, String)> {
    if let Ok(Ok(head_res)) = tokio::time::timeout(
        timeout,
        client
            .head(url)
            .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
            .send(),
    )
    .await
    {
        if is_terminal_http_miss(head_res.status()) {
            return None;
        }
        if head_res.status().is_success() {
            let ctype = head_res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let len = head_res
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok());
            if !headers_hit(&ctype, len) {
                return None;
            }
            if let Some(len) = len {
                match fetch_range_head(client, url, timeout).await {
                    RangeProbeOutcome::Verified(hit) => return hit,
                    RangeProbeOutcome::NeedFallback => {
                        return Some((len, ctype));
                    }
                }
            }
            if let RangeProbeOutcome::Verified(hit) = fetch_range_head(client, url, timeout).await {
                return hit;
            }
        } else {
            if let RangeProbeOutcome::Verified(hit) = fetch_range_head(client, url, timeout).await {
                return hit;
            }
        }
    } else {
        if let RangeProbeOutcome::Verified(hit) = fetch_range_head(client, url, timeout).await {
            return hit;
        }
    }
    let req = client
        .get(url)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .send();
    let resp = tokio::time::timeout(timeout, req).await.ok()?.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !headers_hit(&ctype, None) {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() < MIN_IMAGE_BYTES {
        return None;
    }
    if !magic_is_image(&bytes[..bytes.len().min(1024)], &ctype) {
        return None;
    }
    Some((bytes.len(), ctype))
}

/// 投稿预检自定义图标 Range 拉取上限（64 KiB）。
pub(crate) const PREFLIGHT_ICON_RANGE_CAP: usize = 64 * 1024;

fn parse_total_len_headers(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.parse::<usize>().ok())
        .or_else(|| {
            headers
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok())
        })
}

/// Range 请求拉取首 32KB 验证 content-type 与魔数；服务端忽略 Range 返回全量时仅取首块截断。
async fn fetch_range_head(
    client: &reqwest::Client,
    url: &str,
    timeout: std::time::Duration,
) -> RangeProbeOutcome {
    use futures_util::StreamExt;
    let req = client
        .get(url)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_RANGE_BYTES - 1),
        )
        .send();
    let Ok(Ok(resp)) = tokio::time::timeout(timeout, req).await else {
        return RangeProbeOutcome::NeedFallback;
    };
    let status = resp.status();
    if is_terminal_http_miss(status) {
        return RangeProbeOutcome::Verified(None);
    }
    if !(status.is_success() || status.as_u16() == 206) {
        return RangeProbeOutcome::NeedFallback;
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // content-range 声明的总长度可直接用于“≥300B”判定，避免读 body；
    // 服务器忽略 Range 回 200 时退到 content-length，同样免 body 预检。
    let total_len = parse_total_len_headers(resp.headers());
    if !headers_hit(&ctype, total_len) {
        return RangeProbeOutcome::Verified(None);
    }
    // 只取流首块：即使服务器忽略 Range 返回全量，也仅截取 32KB 窗口避免全量等待。
    let mut fused = resp.bytes_stream().fuse();
    let Some(Ok(mut first)) = fused.next().await else {
        return RangeProbeOutcome::NeedFallback;
    };
    if first.len() > PROBE_RANGE_BYTES {
        first.truncate(PROBE_RANGE_BYTES);
    }
    if first.len() < MIN_IMAGE_BYTES && total_len.is_none_or(|n| n < MIN_IMAGE_BYTES) {
        return RangeProbeOutcome::Verified(None);
    }
    let head = &first[..first.len().min(1024)];
    // `magic_is_image` 内已含 octet-stream 严格分支：明确 image/* 无已知 magic 时放行
    //（如渐进式 jpeg 变体）。
    if !magic_is_image(head, &ctype) {
        return RangeProbeOutcome::Verified(None);
    }
    // 返回服务端声明的总长度（若有），否则返回已下载的首包长度，保证 ≥300。
    let reported = total_len.unwrap_or(first.len()).max(first.len());
    RangeProbeOutcome::Verified(Some((reported, ctype)))
}

/// D8 首包验图（token-less 图标池）：校验扩展名、HEAD 预检（404/410 短路 + Content-Type/长度），
/// 再发 `Range: bytes=0-65535` 读取至多 64 KiB，校验长度 ≥300B 与图片魔数。
pub(crate) async fn verify_custom_icon_d8(client: &reqwest::Client, url: &str) -> bool {
    use futures_util::StreamExt;
    if !crate::icons::url_ext_allowed(url) {
        return false;
    }
    let timeout = crate::config::api_timeout_or(std::time::Duration::from_secs(8));
    if let Ok(Ok(head_res)) = tokio::time::timeout(
        timeout,
        client
            .head(url)
            .headers(crate::forge::http::icon_headers())
            .send(),
    )
    .await
    {
        if is_terminal_http_miss(head_res.status()) {
            return false;
        }
        if head_res.status().is_success() {
            if let Some(len) = head_res
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok())
            {
                if len < MIN_IMAGE_BYTES {
                    return false;
                }
            }
            let ctype = head_res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .unwrap_or("");
            if !ctype.is_empty() && !content_type_is_image(ctype) {
                return false;
            }
        }
    }

    let req = client
        .get(url)
        .headers(crate::forge::http::icon_headers())
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PREFLIGHT_ICON_RANGE_CAP - 1),
        )
        .send();
    let Ok(Ok(resp)) = tokio::time::timeout(timeout, req).await else {
        return false;
    };
    let status = resp.status();
    if !(status.is_success() || status.as_u16() == 206) {
        return false;
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if !ctype.is_empty() && !content_type_is_image(ctype) {
        return false;
    }
    if parse_total_len_headers(resp.headers()).is_some_and(|n| n < MIN_IMAGE_BYTES) {
        return false;
    }

    let mut stream = resp.bytes_stream();
    let mut head = Vec::with_capacity(4096);
    while let Some(chunk_res) = stream.next().await {
        let Ok(chunk) = chunk_res else {
            return false;
        };
        let remaining = PREFLIGHT_ICON_RANGE_CAP.saturating_sub(head.len());
        if remaining == 0 {
            break;
        }
        let take = chunk.len().min(remaining);
        head.extend_from_slice(&chunk[..take]);
        if head.len() >= PREFLIGHT_ICON_RANGE_CAP
            || (head.len() >= MIN_IMAGE_BYTES && crate::icons::sniff_image_mime(&head).is_some())
        {
            break;
        }
    }
    head.len() >= MIN_IMAGE_BYTES && crate::icons::sniff_image_mime(&head).is_some()
}

#[derive(Debug, Deserialize)]
struct GitTree {
    tree: Vec<GitTreeNode>,
}

#[derive(Debug, Deserialize)]
struct GitTreeNode {
    path: Option<String>,
    #[serde(rename = "type")]
    node_type: Option<String>,
    size: Option<u64>,
}

/// 快路径 SimpleIcons 单 slug 超时（未配置回退 1500ms）。
pub(crate) fn simple_icon_timeout() -> std::time::Duration {
    crate::config::api_timeout_or(std::time::Duration::from_millis(1500))
}
/// 慢路径 Git Trees 超时（未配置回退 12s）。
fn trees_timeout() -> std::time::Duration {
    crate::config::api_timeout_or(std::time::Duration::from_secs(12))
}

/// 近期从 GitHub API 获取到的仓库默认分支缓存，避免后台 L3 探测重复请求。
static KNOWN_DEFAULT_BRANCHES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

const MAX_KNOWN_DEFAULT_BRANCHES: usize = 512;

pub(crate) fn remember_repo_default_branch(owner: &str, repo: &str, branch: &str) {
    let b = branch.trim();
    if b.is_empty() {
        return;
    }
    let key = crate::forge::canonical_app_id_from_parts(owner, repo);
    if key.is_empty() || key == "/" {
        return;
    }
    if let Ok(mut map) = KNOWN_DEFAULT_BRANCHES.lock() {
        if map.len() >= MAX_KNOWN_DEFAULT_BRANCHES && !map.contains_key(&key) {
            if let Some(first_key) = map.keys().next().cloned() {
                map.remove(&first_key);
            }
        }
        map.insert(key, b.to_string());
    }
}

pub(crate) fn known_repo_default_branch(owner: &str, repo: &str) -> Option<String> {
    let key = crate::forge::canonical_app_id_from_parts(owner, repo);
    KNOWN_DEFAULT_BRANCHES
        .lock()
        .ok()
        .and_then(|map| map.get(&key).cloned())
}

/// 归一化探测分支列表，缺失或为空时回退 `["HEAD"]`。
pub(crate) fn normalize_probe_branches(default_branch: Option<&str>) -> Vec<String> {
    if let Some(b) = default_branch.map(str::trim).filter(|s| !s.is_empty()) {
        vec![b.to_string()]
    } else {
        vec!["HEAD".to_string()]
    }
}

/// 解析仓库默认分支供 L3 探测使用，优先复用内存缓存，未命中时查询仓库 API。
pub(crate) async fn resolve_probe_branches(
    client: &reqwest::Client,
    headers: &HeaderMap,
    owner: &str,
    repo: &str,
) -> Vec<String> {
    if let Some(known) = known_repo_default_branch(owner, repo) {
        return vec![known];
    }
    let repo_api = crate::github::github_repo_endpoint(owner, repo);
    if let Ok(Ok(resp)) = tokio::time::timeout(
        crate::config::api_timeout_or(std::time::Duration::from_secs(5)),
        client.get(&repo_api).headers(headers.clone()).send(),
    )
    .await
    {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                let branch = v.get("default_branch").and_then(|x| x.as_str());
                if let Some(b) = branch.map(str::trim).filter(|s| !s.is_empty()) {
                    remember_repo_default_branch(owner, repo, b);
                    return normalize_probe_branches(Some(b));
                }
            }
        }
    }
    normalize_probe_branches(None)
}

/// repo+owner 去重 slug 单循环：先 repo 后 owner，去重后逐个试探。
pub(crate) fn dedup_slugs(owner: &str, repo: &str) -> Vec<String> {
    let mut out = derive_slugs(repo);
    for s in derive_slugs(owner) {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Trees 目录响应体字节上限（熔断超大 monorepo）。
pub(crate) const MAX_TREE_BYTES: usize = 2 * 1024 * 1024;
/// Trees 目录节点数上限。
pub(crate) const MAX_TREE_NODES: usize = 20_000;

/// 判断累加下一分块后是否仍在 `cap` 上限内。
pub(crate) fn tree_body_within_cap(accumulated: usize, next_chunk: usize, cap: usize) -> bool {
    accumulated.saturating_add(next_chunk) <= cap
}

/// 流式读取 Trees 响应体，超过 `cap` 即中断返回 `None`。
async fn read_bounded_tree_bytes(resp: reqwest::Response, cap: usize) -> Option<Vec<u8>> {
    use futures_util::StreamExt;
    let mut buf = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if !tree_body_within_cap(buf.len(), chunk.len(), cap) {
            return None;
        }
        buf.extend_from_slice(&chunk);
    }
    Some(buf)
}

/// 快路径：SimpleIcons 品牌库（免鉴权），每 slug 超时经配置（未设置回退 1500ms），命中即返。
/// 并发 buffered(3) 验图，按 slug 顺序取首个有效，语义与逐个串行一致（去重后通常 ≤2 个）。
pub(crate) async fn probe_simple_icons(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Option<ProbedIcon> {
    use futures_util::StreamExt as _;
    let slugs = dedup_slugs(owner, repo);
    if slugs.is_empty() {
        return None;
    }
    let timeout = simple_icon_timeout();
    let checks: Vec<(String, Option<(usize, String)>)> =
        futures_util::stream::iter(slugs.into_iter().map(|slug| {
            let cdn = format!("https://cdn.simpleicons.org/{slug}");
            async move {
                let hit = verify_image(client, &cdn, timeout).await;
                (cdn, hit)
            }
        }))
        .buffered(3)
        .collect()
        .await;
    for (cdn, hit) in checks {
        if let Some((_, ctype)) = hit {
            if ctype.contains("svg") || ctype.starts_with("image/") {
                return Some(ProbedIcon {
                    url: cdn,
                    source: "simple-icons",
                });
            }
        }
    }
    None
}

/// 慢路径：Git Trees 全库评分（需鉴权头），通过响应体大小与节点数上限熔断超大仓库。
pub(crate) async fn probe_trees(
    client: &reqwest::Client,
    headers: &HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Option<ProbedIcon> {
    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
        urlencoding::encode(branch)
    );
    let req = client.get(&tree_url).headers(headers.clone()).send();
    if let Ok(Ok(resp)) = tokio::time::timeout(trees_timeout(), req).await {
        if resp.status().is_success() {
            if let Some(len) = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok())
            {
                if len > MAX_TREE_BYTES {
                    return None;
                }
            }
            let bytes = read_bounded_tree_bytes(resp, MAX_TREE_BYTES).await?;
            let tree: GitTree = serde_json::from_slice(&bytes).ok()?;
            if tree.tree.len() > MAX_TREE_NODES {
                return None;
            }
            let mut best: Option<(i32, u64, String)> = None;
            for node in tree
                .tree
                .iter()
                .filter(|n| n.node_type.as_deref() == Some("blob") && n.path.is_some())
            {
                let p = node.path.as_deref().unwrap_or("");
                let s = score_candidate(p, node.size, repo);
                if s > 0 && node.size.is_none_or(|z| z >= MIN_IMAGE_BYTES as u64) {
                    let cand = (s, node.size.unwrap_or(0), p.to_string());
                    if best
                        .as_ref()
                        .is_none_or(|b| cand.0 > b.0 || (cand.0 == b.0 && cand.1 > b.1))
                    {
                        best = Some(cand);
                    }
                }
            }
            if let Some((_, _size, path)) = best {
                return Some(ProbedIcon {
                    url: raw_url(owner, repo, branch, &path),
                    source: "trees",
                });
            }
        }
    }
    None
}

/// 图标探测主入口（Simple Icons 品牌库 → Git Trees 全库评分）。
/// `icon_client` 专用于 Simple Icons CDN 通道，`api_client` 专用于带鉴权头的 GitHub API Trees 通道；
/// `headers` 传 `Some` 带 token 鉴权头则含 Trees 级；传 `None` 只做免鉴权级。
pub(crate) async fn probe_repo_logo(
    icon_client: &reqwest::Client,
    api_client: &reqwest::Client,
    headers: Option<&HeaderMap>,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Option<ProbedIcon> {
    // 先快后慢：快命中即返，不阻塞慢路径；无 token 只走快路径。
    if let Some(hit) = probe_simple_icons(icon_client, owner, repo).await {
        return Some(hit);
    }
    // 2. Git Trees 全库评分（需鉴权头；无 token 时跳过以保护匿名配额）。
    if let Some(hdrs) = headers {
        if let Some(hit) = probe_trees(api_client, hdrs, owner, repo, branch).await {
            return Some(hit);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_slugs() {
        assert_eq!(
            derive_slugs("SeriousSamClassic-VK"),
            vec!["serioussamclassicvk", "serioussamclassic-vk"]
        );
        assert_eq!(derive_slugs("vscode"), vec!["vscode"]);
        assert!(derive_slugs("").is_empty());
        assert!(derive_slugs("###").is_empty());
    }

    #[test]
    fn test_score_candidate_core() {
        assert!(score_candidate("assets/icon.png", Some(5000), "demo") >= 100);
        assert!(score_candidate("logo.svg", Some(2000), "demo") >= 90);
        assert_eq!(score_candidate("a.jpg", Some(5000), "demo"), -100);
        assert_eq!(
            score_candidate("node_modules/icon.png", Some(5000), "demo"),
            -100
        );
        assert_eq!(
            score_candidate("docs/screenshot.png", Some(5000), "demo"),
            -50
        );
        assert_eq!(score_candidate("x/icon.png", Some(100), "demo"), -100);
        assert!(
            score_candidate(
                "src/icons/monochrome/svg/vidicon-line.svg",
                Some(435),
                "duckstation"
            ) < 50
        );
    }

    #[test]
    fn test_raw_url_shape() {
        assert_eq!(
            raw_url("o", "r", "main", "a/b.png"),
            "https://raw.githubusercontent.com/o/r/main/a/b.png"
        );
        assert_eq!(
            raw_url("o", "r", "main", "/a/b.png"),
            "https://raw.githubusercontent.com/o/r/main/a/b.png"
        );
    }

    #[test]
    fn test_is_readme_body_image_path_segment() {
        // 正文图（排除）：文件名 stem 精确匹配（+复数）或 shields.io 域名。
        let body_true = [
            "https://raw.githubusercontent.com/o/r/main/docs/screenshot.png",
            "https://raw.githubusercontent.com/o/r/main/assets/preview.png",
            "https://raw.githubusercontent.com/o/r/main/assets/banner.svg",
            "https://img.shields.io/badge/build-passing-brightgreen",
            "https://raw.githubusercontent.com/o/r/main/docs/demo.gif",
            "assets/diagram.svg",
            "docs/architecture.png",
            "https://raw.githubusercontent.com/o/r/main/assets/cover.png",
            "https://github.com/o/r/actions/workflows/ci.yml/badge.svg",
            "assets/license.svg",
            "docs/screenshots.png",
            "assets/badges.svg",
            "assets/workflow.svg",
        ];
        for u in body_true {
            assert!(is_readme_body_image(u), "expected body image: {u}");
        }
        // trees 评分侧：png/svg/ico 文件形态的正文图吃 -50（与上表同源，取子集复核）。
        for p in [
            "docs/screenshot.png",
            "assets/preview.png",
            "assets/banner.svg",
            "assets/diagram.svg",
            "docs/architecture.png",
            "assets/cover.png",
            "assets/license.svg",
            "docs/screenshots.png",
        ] {
            assert_eq!(
                score_candidate(p, Some(5000), "demo"),
                -50,
                "score_candidate should penalize body file: {p}"
            );
        }

        // 合法 Logo（保留）：含关键词子串但 stem 非精确匹配，或 logo/icon 优先放行。
        let logo_false = [
            "https://raw.githubusercontent.com/o/r/main/assets/preview-logo.png",
            "https://raw.githubusercontent.com/o/r/main/assets/demo-icon.svg",
            "https://cdn.simpleicons.org/rust",
            "https://raw.githubusercontent.com/o/r/main/assets/logo.png",
            "https://raw.githubusercontent.com/o/r/main/res/icon.png",
            "https://raw.githubusercontent.com/o/r/main/assets/discover.png",
            "https://raw.githubusercontent.com/o/r/main/assets/badger.png",
            "https://raw.githubusercontent.com/o/r/main/assets/demonstration.svg",
            "https://raw.githubusercontent.com/o/r/main/assets/app-preview.png",
            "https://raw.githubusercontent.com/o/r/main/assets/my-screenshot-logo.png",
        ];
        for u in logo_false {
            assert!(!is_readme_body_image(u), "expected legit logo kept: {u}");
        }
        // 合法 Logo 在 trees 评分侧不吃 -50（以 preview-logo / discover 为代表）。
        assert_ne!(
            score_candidate("assets/preview-logo.png", Some(5000), "demo"),
            -50
        );
        assert_ne!(
            score_candidate("assets/discover.png", Some(5000), "demo"),
            -50
        );
    }

    #[test]
    fn test_tree_body_caps_are_bounded() {
        assert_eq!(MAX_TREE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_TREE_NODES, 20_000);
    }

    #[test]
    fn test_tree_body_within_cap_stops_at_limit() {
        assert!(tree_body_within_cap(0, 100, MAX_TREE_BYTES));
        assert!(tree_body_within_cap(MAX_TREE_BYTES - 1, 1, MAX_TREE_BYTES));
        assert!(!tree_body_within_cap(MAX_TREE_BYTES, 1, MAX_TREE_BYTES));
        assert!(!tree_body_within_cap(
            MAX_TREE_BYTES - 10,
            11,
            MAX_TREE_BYTES
        ));
        // 无长度声明的 chunked 分块同样逐块判定：模拟 3 块，前两块受理、第三块超限中断。
        let cap = 10usize;
        let mut acc = 0usize;
        for chunk in [4usize, 4, 4] {
            if !tree_body_within_cap(acc, chunk, cap) {
                acc = usize::MAX;
                break;
            }
            acc += chunk;
        }
        assert_eq!(acc, usize::MAX, "third chunk must abort, not buffer");
    }

    #[test]
    fn test_is_terminal_http_miss_status_codes() {
        assert!(is_terminal_http_miss(reqwest::StatusCode::NOT_FOUND));
        assert!(is_terminal_http_miss(reqwest::StatusCode::GONE));
        assert!(!is_terminal_http_miss(reqwest::StatusCode::OK));
        assert!(!is_terminal_http_miss(reqwest::StatusCode::FORBIDDEN));
        assert!(!is_terminal_http_miss(
            reqwest::StatusCode::METHOD_NOT_ALLOWED
        ));
        assert!(!is_terminal_http_miss(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(!is_terminal_http_miss(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
    }

    #[test]
    fn test_normalize_probe_branches_falls_back_to_head() {
        assert_eq!(
            normalize_probe_branches(Some("main")),
            vec!["main".to_string()]
        );
        assert_eq!(
            normalize_probe_branches(Some("  master  ")),
            vec!["master".to_string()]
        );
        assert_eq!(normalize_probe_branches(Some("")), vec!["HEAD".to_string()]);
        assert_eq!(
            normalize_probe_branches(Some("   ")),
            vec!["HEAD".to_string()]
        );
        assert_eq!(normalize_probe_branches(None), vec!["HEAD".to_string()]);
    }

    #[tokio::test]
    async fn test_verify_image_short_circuits_on_404_and_falls_back_on_405() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 1. HEAD 返回 404 Not Found：verify_image 仅发送 1 次 HEAD 请求即短路返回 None。
        let listener_404 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_404 = listener_404.local_addr().unwrap();
        let hits_404 = Arc::new(AtomicUsize::new(0));
        let hits_404_clone = hits_404.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener_404.accept().await {
                hits_404_clone.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        });

        let client = reqwest::Client::new();
        let url_404 = format!("http://{}/missing.svg", addr_404);
        let res_404 = verify_image(&client, &url_404, std::time::Duration::from_secs(2)).await;
        assert!(res_404.is_none());
        assert_eq!(
            hits_404.load(Ordering::SeqCst),
            1,
            "404 on HEAD must short-circuit without Range GET or full GET"
        );

        // 2. HEAD 返回 405 Method Not Allowed：verify_image 回退 Range GET 验魔数命中。
        let listener_405 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_405 = listener_405.local_addr().unwrap();
        let hits_405 = Arc::new(AtomicUsize::new(0));
        let hits_405_clone = hits_405.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener_405.accept().await {
                let n = hits_405_clone.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                if n == 0 {
                    let _ = sock
                        .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                } else {
                    let mut body = b"\x89PNG\r\n\x1a\n".to_vec();
                    body.resize(400, 0u8);
                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(header.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                }
            }
        });

        let url_405 = format!("http://{}/icon.png", addr_405);
        let res_405 = verify_image(&client, &url_405, std::time::Duration::from_secs(2)).await;
        assert!(res_405.is_some(), "405 on HEAD must fall back to Range GET");
        assert_eq!(
            hits_405.load(Ordering::SeqCst),
            2,
            "HEAD (405) + Range GET (206) = 2 requests, no 3rd full GET"
        );
    }
}
