//! 图标五级探测（与 z-store-catalog `scripts/lib/catalog-shared.mjs` 同源逻辑）：
//! 种子提示 → Simple Icons 品牌库 → Git Trees 全库评分 → 静态路径 →（调用方）头像兜底。
//! 调用方找不到缓存时按此逻辑派生替代图标 URL；本模块只负责“找 URL 并验字节”，
//! 缓存读写仍由调用方（`commands::icons` / `github::detail`）负责。

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

/// 启发式评分（与 catalog-shared `scoreIconCandidate` 同规则）。
/// 非 png/svg/ico 直接 -100；命中正分才会被采用。
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
    if lower.contains("screenshot")
        || lower.contains("preview")
        || lower.contains("banner")
        || lower.contains("badge")
        || lower.contains("demo")
        || lower.contains("diagram")
        || lower.contains("architecture")
        || lower.contains("cover")
    {
        return -50;
    }
    if lower.contains("aprilfools") || lower.contains("xmas") || lower.contains("christmas") {
        return -30;
    }
    // 排除 Git LFS 指针文本文件（~130 字节）。
    if size.is_some_and(|s| s < 300) {
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

/// 静态候选路径（与 catalog-shared 一致，经 jsDelivr 实测后返回 raw 权威 URL）。
fn static_paths() -> [&'static str; 13] {
    [
        "res/icon.png",
        "assets/icon.png",
        "assets/logo.png",
        "assets/app-icon.png",
        "src-tauri/icons/icon.png",
        "buildResources/icon.png",
        "public/icon.png",
        "public/logo.png",
        "public/app-icon.png",
        "resources/icon.png",
        "icon.png",
        "logo.png",
        "logo.svg",
    ]
}

fn jsdelivr_url(owner: &str, repo: &str, branch: &str, file_path: &str) -> String {
    format!(
        "https://cdn.jsdelivr.net/gh/{}/{}@{}/{}",
        owner,
        repo,
        branch,
        file_path.trim_start_matches('/')
    )
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

const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 实测图片字节：200 + image/* + ≥300B（与 `verifyImageBytes` 同阈值）。
/// 返回 `(字节数, content-type)`。
async fn verify_image(client: &reqwest::Client, url: &str, timeout: std::time::Duration) -> Option<(usize, String)> {
    let req = client.get(url).header("User-Agent", BROWSER_UA).send();
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
    if !(ctype.starts_with("image/") || ctype.contains("octet-stream") || ctype.contains("svg")) {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() < 300 {
        return None;
    }
    Some((bytes.len(), ctype))
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

/// 五级探测主入口。`headers` 传入带 token 的鉴权头则含 Trees 级；
/// 传 `None`（如无 token 的图标命令回退路径）则跳过 Trees，只做免鉴权级。
/// `icon_hint` 为种子/收录库提示的相对路径。命中返回权威 URL，未命中返回 `None` 由调用方用头像兜底。
pub(crate) async fn probe_repo_logo(
    client: &reqwest::Client,
    headers: Option<&HeaderMap>,
    owner: &str,
    repo: &str,
    branch: &str,
    icon_hint: Option<&str>,
) -> Option<ProbedIcon> {
    // 0. 种子提示。
    if let Some(hint) = icon_hint.map(str::trim).filter(|h| !h.is_empty()) {
        let probe = jsdelivr_url(owner, repo, branch, hint);
        if verify_image(client, &probe, std::time::Duration::from_secs(10))
            .await
            .is_some()
        {
            return Some(ProbedIcon {
                url: raw_url(owner, repo, branch, hint),
                source: "hint",
            });
        }
    }

    // 1. Simple Icons 品牌库（免鉴权）。
    for slug in derive_slugs(repo) {
        let cdn = format!("https://cdn.simpleicons.org/{slug}");
        if let Some((_, ctype)) = verify_image(client, &cdn, std::time::Duration::from_secs(10)).await
        {
            if ctype.contains("svg") || ctype.starts_with("image/") {
                return Some(ProbedIcon {
                    url: cdn,
                    source: "simple-icons",
                });
            }
        }
    }

    // 2. Git Trees 全库评分（需鉴权头；无 token 时跳过以保护匿名配额）。
    if let Some(hdrs) = headers {
        let tree_url = format!(
            "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
            owner, repo, branch
        );
        let req = client.get(&tree_url).headers(hdrs.clone()).send();
        if let Ok(Ok(resp)) = tokio::time::timeout(std::time::Duration::from_secs(12), req).await {
            if resp.status().is_success() {
                if let Ok(tree) = resp.json::<GitTree>().await {
                    let mut best: Option<(i32, u64, String)> = None;
                    for node in tree.tree.iter().filter(|n| {
                        n.node_type.as_deref() == Some("blob") && n.path.is_some()
                    }) {
                        let p = node.path.as_deref().unwrap_or("");
                        let s = score_candidate(p, node.size, repo);
                        if s > 0 && node.size.is_none_or(|z| z >= 300) {
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
        }
    }

    // 3. 静态路径（经 jsDelivr 实测后返回 raw 权威 URL）。
    for candidate in static_paths() {
        let probe = jsdelivr_url(owner, repo, branch, candidate);
        if verify_image(client, &probe, std::time::Duration::from_secs(10))
            .await
            .is_some()
        {
            return Some(ProbedIcon {
                url: raw_url(owner, repo, branch, candidate),
                source: "static",
            });
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
    fn test_mirror_url_shapes() {
        assert_eq!(
            jsdelivr_url("o", "r", "main", "/a/b.png"),
            "https://cdn.jsdelivr.net/gh/o/r@main/a/b.png"
        );
        assert_eq!(
            raw_url("o", "r", "main", "a/b.png"),
            "https://raw.githubusercontent.com/o/r/main/a/b.png"
        );
    }
}
