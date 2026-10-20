//! 图标探测原语 SSOT（与 z-store-catalog 同源逻辑）：
//! 品牌库 Simple Icons → 翻全家 Git Trees 全库评分。
//! 调用方找不到缓存时按此逻辑派生替代图标 URL；本模块只负责“找 URL 并验字节”，
//! 缓存读写仍由调用方（`commands::icons` / `github::detail`）负责。
//!
//! C1 深核分工：本文件为探针原语层（`derive_slugs`/`score_candidate`/
//! `verify_image`+`fetch_range_head`/`probe_simple_icons`/`probe_trees`/
//! `resolve_probe_branches`，`buffered(3)`+首包验图+caps），调度与 L2→L3 编排
//! 在 `github::icon_fetch` 深核（`probe_single_live`/`fetch_icons_stream` +
//! `scaled_total_timeout` 纯决策）。所有探测一律经深核直调本原语（无串行 naive 探路径），
//! 本模块永不触 DB/fs（无 `Database`/`std::fs` 引用，
//! probe-vs-persist 缝纯侧），持久化单一路径在 `icons_cycle_probe::write_icon_file`。
//! D5/D6/D8：双池复用（调用方给 client，CDN 恒丢 token）+ `buffered(3)` 有界 +
//! 首包验图与跳过（HEAD→Range 首 32KB→magic→300B）。
//! level 纯L（2=L2品牌库，3=L3仓库），via=live|m2 正交（本层只产 live URL，
//! M2 回填由调用方经 via=m2 直发）；key 小写 owner/repo（ADR-0010）。

use reqwest::header::HeaderMap;
use serde::Deserialize;

/// 探测命中结果：权威 URL（统一用 `raw.githubusercontent.com`，除 Simple Icons 用其 CDN）。
pub(crate) struct ProbedIcon {
    pub url: String,
    pub source: &'static str,
}

/// 由仓库名派生 Simple Icons slug 候选（小写去分隔符优先，保留原样其次）。
/// 例：`SeriousSamClassic-VK` → `["serioussamclassicvk", "serioussamclassic-vk"]`
pub(crate) fn derive_slugs(repo: &str) -> Vec<String> {
    let lower = repo.trim().to_lowercase();
    let stripped: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    // 纯符号名派生不出可用 slug，直接返回空（调用方逐个试错无意义）。
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

/// README 正文图判别 SSOT（ADR-0015 §3 单一探源，供 `score_candidate` 负分 +
/// `icon_fetch::is_body_image_url` 共用）：
/// - 关键词见 [`BODY_IMAGE_KEYWORDS`] + `shields.io` 域名（badge CDN，trees 路径永不出现但 URL 侧需判）；
/// - 口径为 path-segment 精确匹配：取 URL/path 最后一段文件名，去扩展名 + 剥 query/fragment 后小写全等
///   （或复数 `+s` 全等），非 substring。`preview-logo.png` / `demo-icon.svg` /
///   `discover.png`（含 `cover` 子串）/ `badger.png`（含 `badge` 子串）等含关键词的合法 Logo 不判为正文；
/// - 合法 Logo 优先：文件名含 `logo`/`icon` 直接放行（README L4 提取口径同源），避免误杀；
/// - 仅 README-body 上下文调用（detail.icon 过滤 + trees 评分负分），L2/L3 权威直出不经此。
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

/// README 正文图判别唯一实现（见 [`BODY_IMAGE_KEYWORDS`] 文档）：
/// `shields.io` 域名直接判真；其余取最后 path segment 文件名 stem 精确匹配（+复数），
/// 含 `logo`/`icon` 的合法 Logo 一律放行。
pub(crate) fn is_readme_body_image(path_or_url: &str) -> bool {
    let lower_full = path_or_url.to_ascii_lowercase();
    if lower_full.contains("shields.io") {
        return true;
    }
    let trimmed = path_or_url.trim();
    if trimmed.is_empty() {
        return false;
    }
    // 剥 query/fragment。
    let no_frag = trimmed.split(['#', '?']).next().unwrap_or(trimmed);
    // 去 scheme://host，保留 path（无 scheme 时整串即 path）。
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
    // 去扩展名（最后一个 '.' 后缀），小写。
    let stem = filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(filename)
        .to_ascii_lowercase();
    let stem = stem.trim();
    if stem.is_empty() {
        return false;
    }
    // 合法 Logo 优先放行（与 README L4 提取的 logo/icon 口径同源）。
    if stem.contains("logo") || stem.contains("icon") {
        return false;
    }
    BODY_IMAGE_KEYWORDS.iter().any(|k| {
        *k == stem || (stem.len() == k.len() + 1 && stem.strip_suffix('s') == Some(*k))
    })
}

/// 启发式评分（与 catalog-shared `scoreIconCandidate` 同规则）。
/// 非 png/svg/ico 直接 -100；命中正分才会被采用。
/// 正文图负分经 [`is_readme_body_image`] 单一探源（README-body 上下文 path-segment 精确匹配，
/// 合法 Logo 含关键词不罚分），substring 表仅此一套。
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
    if ["icon.png", "app-icon.png", "app_icon.png", "logo.png", "applogo.png"].contains(&filename) {
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

    // 降级 UI 字形惩罚（duckstation vidicon-line 回归项：monochrome/symbolic 线框套装
    // 并非应用主图标；JS 端同规则会给出 70 分，此处显式压低）。
    if lower.contains("monochrome") || lower.contains("symbolic") {
        score -= 40;
    }
    if filename.contains("-line") {
        score -= 30;
    }

    // 2. 分辨率加权。
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

    // 3. 语义目录加权。
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
    format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        owner,
        repo,
        branch,
        file_path.trim_start_matches('/')
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
    if chunk.len() >= 12 && chunk.starts_with(b"RIFF") && chunk[8..12.min(chunk.len())] == *b"WEBP" {
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

/// 实测图片字节：200 + image/* + ≥300B（与 `verifyImageBytes` 同阈值）。
/// 返回 `(字节数, content-type)`。
/// 减 payload 策略：HEAD 探 content-type/content-length → Range 首 32KB 验
/// content-type + magic；Range/HEAD 不支持时才回退全量 GET。
async fn verify_image(client: &reqwest::Client, url: &str, timeout: std::time::Duration) -> Option<(usize, String)> {
    // 1. HEAD 轻探：ctype 不对 / 太小直接剪枝，避免 GET body。
    if let Ok(head_res) = tokio::time::timeout(
        timeout,
        client
            .head(url)
            .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
            .send(),
    )
    .await
    .ok()?
    {
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
                // HEAD 已确认类型+长度，紧接 Range 取首包验 magic 即可定案。
                if let Some(hit) = fetch_range_head(client, url, timeout).await {
                    return Some(hit);
                }
                // Range 失败则信任 HEAD（已知 CDN 行为稳定），直接返回头信息。
                return Some((len, ctype));
            }
            // 无 content-length：继续走 Range 首包验证。
            if let Some(hit) = fetch_range_head(client, url, timeout).await {
                return Some(hit);
            }
        }
    }
    // 2. 无 HEAD 信息（或 HEAD 失败）：Range 首包验证。
    if let Some(hit) = fetch_range_head(client, url, timeout).await {
        return Some(hit);
    }
    // 3. 回退：全量 GET（不支持 HEAD/Range 的服务器走此路）。
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
    // 全量回退路径同样验 magic，防止 content-type 伪装。
    // `magic_is_image` 内已含 octet-stream 严格分支，显式 image/* 无已知 magic 时放行。
    if !magic_is_image(&bytes[..bytes.len().min(1024)], &ctype) {
        return None;
    }
    Some((bytes.len(), ctype))
}

/// Range 首 32KB 验图：200/206 + content-type + magic + ≥300B 才算命中。
/// 服务器忽略 Range 返回全量时只取流首块并截断，不全量等待。
async fn fetch_range_head(
    client: &reqwest::Client,
    url: &str,
    timeout: std::time::Duration,
) -> Option<(usize, String)> {
    use futures_util::StreamExt;
    let req = client
        .get(url)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_RANGE_BYTES - 1),
        )
        .send();
    let resp = tokio::time::timeout(timeout, req).await.ok()?.ok()?;
    let status = resp.status();
    if !(status.is_success() || status.as_u16() == 206) {
        return None;
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // content-range 声明的总长度可直接用于“≥300B”判定，避免读 body；
    // 服务器忽略 Range 回 200 时退到 content-length，同样免 body 预检。
    let total_len = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.parse::<usize>().ok())
        .or_else(|| {
            resp.headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok())
        });
    if !headers_hit(&ctype, total_len) {
        return None;
    }
    // 只取流首块：服务器忽略 Range 回全量时不再全量等待；超窗口截断到 32KB。
    let mut fused = resp.bytes_stream().fuse();
    let mut first = fused.next().await?.ok()?;
    if first.len() > PROBE_RANGE_BYTES {
        first.truncate(PROBE_RANGE_BYTES);
    }
    if first.len() < MIN_IMAGE_BYTES && total_len.is_none_or(|n| n < MIN_IMAGE_BYTES) {
        return None;
    }
    let head = &first[..first.len().min(1024)];
    // `magic_is_image` 内已含 octet-stream 严格分支：明确 image/* 无已知 magic 时放行
    //（如渐进式 jpeg 变体）。
    if !magic_is_image(head, &ctype) {
        return None;
    }
    // 返回服务端声明的总长度（若有），否则返回已下载的首包长度，保证 ≥300。
    let reported = total_len.unwrap_or(first.len()).max(first.len());
    Some((reported, ctype))
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

/// 图标探测主入口（Simple Icons 品牌库 → Git Trees 全库评分）。
/// `headers` 传入带 token 的鉴权头则含 Trees 级；
/// 传 `None`（如无 token 的图标命令回退路径）则跳过 Trees，只做免鉴权级。
/// 命中返回权威 URL，未命中返回 `None`。
/// 快慢分离超时：取统一配置中枢 `api_timeout_seconds`，0 视为未设置用缺省；
/// 快路径 SimpleIcons 每 slug 缺省 1500ms（免鉴权），慢路径 Trees 缺省 12s（需鉴权）。
/// ADR-0008：网络超时统一经 `config::api_timeout_or` 单一来源（统一配置中枢同一键）。
pub(crate) fn simple_icon_timeout() -> std::time::Duration {
    crate::config::api_timeout_or(std::time::Duration::from_millis(1500))
}
fn trees_timeout() -> std::time::Duration {
    crate::config::api_timeout_or(std::time::Duration::from_secs(12))
}

/// Trees 探测分支：仓库 `default_branch`（经 [`resolve_probe_branches`]
/// 动态解析；接口失败/超时返回空，调用方跳过 L3）。
/// 动态分支解析共用（搜索 `icon_fetch` + 详情 cycle L3 + 匿名兜底）：
/// GET `repos/{owner}/{repo}` 取 `default_branch`（5s 超时，
/// 失败/超时/空值返回空，调用方跳过 L3）。
/// 返回 0 或 1 个分支（trim 后去空）。
pub(crate) async fn resolve_probe_branches(
    client: &reqwest::Client,
    headers: &HeaderMap,
    owner: &str,
    repo: &str,
) -> Vec<String> {
    let repo_api = format!("https://api.github.com/repos/{}/{}", owner, repo);
    if let Ok(Ok(resp)) = tokio::time::timeout(
        crate::config::api_timeout_or(std::time::Duration::from_secs(5)),
        client.get(&repo_api).headers(headers.clone()).send(),
    )
    .await
    {
        if let Ok(v) = resp.json::<serde_json::Value>().await {
            if let Some(b) = v.get("default_branch").and_then(|x| x.as_str()) {
                let b = b.trim();
                if !b.is_empty() {
                    return vec![b.to_string()];
                }
            }
        }
    }
    Vec::new()
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

/// Trees 目录响应有界上限（超大单体仓库熔断）：
/// - `MAX_TREE_BYTES` 2MB：正常仓库 tree JSON 远小于此值；超限多为 monorepo/大仓，直接放弃；
/// - `MAX_TREE_NODES` 2 万节点：评分 O(n) 本身便宜，主要防超大 JSON 解析阻塞。
///
/// 超限直接 `None` 不阻塞主流程（该行保持徽章/裸行，同批其他行不受影响）。
pub(crate) const MAX_TREE_BYTES: usize = 2 * 1024 * 1024;
/// 2 万节点上限（见 [`MAX_TREE_BYTES`] 文档）。
pub(crate) const MAX_TREE_NODES: usize = 20_000;

/// 有界累积纯决策（可单测，无网络）：已累积 `accumulated` + 下一块 `next_chunk`
/// 未超 `cap` 即 true，超限即 false（调用方中断降级，不全量缓冲）。
pub(crate) fn tree_body_within_cap(accumulated: usize, next_chunk: usize, cap: usize) -> bool {
    accumulated.saturating_add(next_chunk) <= cap
}

/// 有界目录体流式读取：逐块累积，超 `cap` 即中断返 `None`
/// （无长度声明的 chunked 响应同样有界，不全量缓冲；中断后调用方降级为徽章/裸行）。
/// 网络分块失败同样返 `None`（调用方同语义降级）。
async fn read_bounded_tree_bytes(resp: reqwest::Response, cap: usize) -> Option<Vec<u8>> {
    use futures_util::StreamExt;
    let mut buf = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if !tree_body_within_cap(buf.len(), chunk.len(), cap) {
            log::warn!(
                "icon probe trees skip oversized stream streamed={} > {}",
                buf.len().saturating_add(chunk.len()),
                cap
            );
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
    let checks: Vec<(String, Option<(usize, String)>)> = futures_util::stream::iter(
        slugs.into_iter().map(|slug| {
            let cdn = format!("https://cdn.simpleicons.org/{slug}");
            async move {
                let hit = verify_image(client, &cdn, timeout).await;
                (cdn, hit)
            }
        }),
    )
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

/// 慢路径：Git Trees 全库评分（需鉴权头），超时经配置（未设置回退 12s）。
/// 截断保护：Git Trees 无分页（`per_page` 不适用），此处以
/// content-length 预检 + 有界流式体 + 节点数上限三层熔断；超限直接 `None`
/// 不阻塞主流程（该行保持徽章/裸行，同批其他行不受影响，见统一图标补探 `IconFetch`）。
pub(crate) async fn probe_trees(
    client: &reqwest::Client,
    headers: &HeaderMap,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Option<ProbedIcon> {
    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        owner, repo, branch
    );
    let req = client.get(&tree_url).headers(headers.clone()).send();
    if let Ok(Ok(resp)) = tokio::time::timeout(trees_timeout(), req).await {
        if resp.status().is_success() {
            // 层1：content-length 预检（chunked 缺头时跳过，由层2兜底）。
            if let Some(len) = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok())
            {
                if len > MAX_TREE_BYTES {
                    log::warn!(
                        "icon probe trees skip {}/{} oversized content-length={} > {}",
                        owner,
                        repo,
                        len,
                        MAX_TREE_BYTES
                    );
                    return None;
                }
            }
            // 层2：有界流式体。无长度声明的 chunked 响应逐块累积、超限即中断，
            // 不全量缓冲；中断返 `None` 降级为徽章/裸行（内存有界）。
            let bytes = read_bounded_tree_bytes(resp, MAX_TREE_BYTES).await?;
            let tree: GitTree = serde_json::from_slice(&bytes).ok()?;
            // 层3：节点数上限。
            if tree.tree.len() > MAX_TREE_NODES {
                log::warn!(
                    "icon probe trees skip {}/{} too many nodes={} > {}",
                    owner,
                    repo,
                    tree.tree.len(),
                    MAX_TREE_NODES
                );
                return None;
            }
                let mut best: Option<(i32, u64, String)> = None;
                for node in tree.tree.iter().filter(|n| {
                    n.node_type.as_deref() == Some("blob") && n.path.is_some()
                }) {
                    let p = node.path.as_deref().unwrap_or("");
                    let s = score_candidate(p, node.size, repo);
                    if s > 0 && node.size.is_none_or(|z| z >= MIN_IMAGE_BYTES as u64) {
                        let cand = (s, node.size.unwrap_or(0), p.to_string());
                        if best.as_ref().is_none_or(|b| cand.0 > b.0 || (cand.0 == b.0 && cand.1 > b.1)) {
                            best = Some(cand);
                        }
                    }
                }
                if let Some((_, size, path)) = best {
                    log::debug!("icon probe trees hit {}/{} path='{}' size={}", owner, repo, path, size);
                    return Some(ProbedIcon {
                        url: raw_url(owner, repo, branch, &path),
                        source: "trees",
                    });
                }
        }
    }
    None
}

pub(crate) async fn probe_repo_logo(
    client: &reqwest::Client,
    headers: Option<&HeaderMap>,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Option<ProbedIcon> {
    // 先快后慢：快命中即返，不阻塞慢路径；无 token 只走快路径。
    if let Some(hit) = probe_simple_icons(client, owner, repo).await {
        return Some(hit);
    }
    // 2. Git Trees 全库评分（需鉴权头；无 token 时跳过以保护匿名配额）。
    if let Some(hdrs) = headers {
        if let Some(hit) = probe_trees(client, hdrs, owner, repo, branch).await {
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
        assert_eq!(derive_slugs("SeriousSamClassic-VK"), vec!["serioussamclassicvk", "serioussamclassic-vk"]);
        assert_eq!(derive_slugs("vscode"), vec!["vscode"]);
        assert!(derive_slugs("").is_empty());
        assert!(derive_slugs("###").is_empty());
    }

    #[test]
    fn test_score_candidate_core() {
        assert!(score_candidate("assets/icon.png", Some(5000), "demo") >= 100);
        assert!(score_candidate("logo.svg", Some(2000), "demo") >= 90);
        assert_eq!(score_candidate("a.jpg", Some(5000), "demo"), -100);
        assert_eq!(score_candidate("node_modules/icon.png", Some(5000), "demo"), -100);
        assert_eq!(score_candidate("docs/screenshot.png", Some(5000), "demo"), -50);
        assert_eq!(score_candidate("x/icon.png", Some(100), "demo"), -100);
        // 单色/行图标类小 glyph 应为低分（duckstation vidicon-line 回归项）。
        assert!(score_candidate("src/icons/monochrome/svg/vidicon-line.svg", Some(435), "duckstation") < 50);
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
        // 超大单体仓库熔断阈值锁定：目录体 2MB + 节点 2 万（内存有界）。
        assert_eq!(MAX_TREE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_TREE_NODES, 20_000);
    }

    #[test]
    fn test_tree_body_within_cap_stops_at_limit() {
        // 有界累积纯决策：未超限 true，超限即 false（调用方中断降级为徽章/裸行）。
        assert!(tree_body_within_cap(0, 100, MAX_TREE_BYTES));
        assert!(tree_body_within_cap(MAX_TREE_BYTES - 1, 1, MAX_TREE_BYTES));
        assert!(!tree_body_within_cap(MAX_TREE_BYTES, 1, MAX_TREE_BYTES));
        assert!(!tree_body_within_cap(MAX_TREE_BYTES - 10, 11, MAX_TREE_BYTES));
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
}
