use crate::AppState;
use serde::{Deserialize, Serialize};

// 图标 C1 深核适配层（薄）：探测经 `github::icon_fetch` 深核直调
// `icon_probe` 原语（L2/L3-live 纯探，不碰 DB/fs），持久化经单一写入路径
// `persist_icon_bytes`（`catalog vs cycle` 文件名分流收敛在内 + `icons/` 落盘 +
// `icon_cache_meta` 同步），下载经 `download_via_mirror`（ADR-0002：mirror 只改
// 下载 URL，API/登录仍直连）；L1=官方填充 + L4=README 现场扒分居本适配器
//（详情链专属，不受流式核约束），L5 空选经 `empty_cycle_result` + `seal_empty_selection`。
// 已删：串行 naive `probe_simple_icons`/`probe_git_trees` 重复拷贝、
// `SEARCH_PROBE_BRANCHES` 第三套分支硬编码、匿名分支循环浪费——一律经深核。
// 已收敛：`persist_catalog_icon`/`cleanup_stale_cycle_variants` 降为缝内私有，
// 命令层不再直调双持久化/mirror 两段式/L5 散字面量（probe-vs-persist 缝合一）。
// 趋势 enrich 已切流式直路（见 `catalog_search::enrich_trend_repos`），
// 本适配器不为旧等齐路分支。

// ADR-0008：网络超时统一经 `config::api_timeout_or` 单一来源（统一配置中枢同一键）；
// 配置为 0（未设置）时回退到调用方传入的历史硬编码值，行为保持不变。
pub(crate) use crate::config::api_timeout_or;

/// 图标轮换返回结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IconCycleResult {
    pub url: String,
    pub remote_url: String,
    pub level: i32,
    pub source: String,
    pub is_fallback: bool,
    pub total_levels: usize,
    pub is_cataloged: bool,
}

pub(crate) use crate::db::icon_cycle::{
    first_available_level, is_fallback_for_level, next_cycle_level, source_for_level,
};

/// 解析入站应用标识（薄委托：本体见 db::icon_cycle::resolve_icon_coord）：
/// 非收录 app_id 允许 owner/repo 直通（不经过必须在收录库中的强校验）。
pub(crate) fn resolve_app_coord(app_id: &str) -> Result<(String, String, String), String> {
    let (canon, repo) = crate::db::icon_cycle::resolve_icon_coord(app_id)?;
    Ok((canon, repo.owner, repo.repo))
}

/// 镜像改写唯一落点：统一走镜像改写逻辑；
/// 改写无变化时返回 None（调用方直连）。
/// ADR-0002：仅改下载 URL（本下载通道专用），API 与登录直接走系统网络通道。
pub(crate) fn mirror_url_for(state: &AppState, url: &str) -> Option<String> {
    state.mirror.lock().ok().and_then(|m| {
        let rewritten = m.rewrite_download_url(url);
        if rewritten != url {
            Some(rewritten)
        } else {
            None
        }
    })
}

/// 下载唯一落点（mirror rewrite 重复收敛点，ADR-0002）：
/// `mirror_url_for` 改写 + `icons::download_icon_bytes` 拉取二合一。
/// 命令层不再手写两段式（改写 + 拉取），一律经此（API/登录仍直连，mirror 仅本通道）。
pub(crate) async fn download_via_mirror(
    state: &AppState,
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    let mirror = mirror_url_for(state, url);
    crate::commands::icons::download_icon_bytes(client, mirror.as_deref(), url).await
}

/// L5 空态返回统一构造（首字母徽章，level 纯L=5）：
/// `url/remote=""` + source=none + fallback=true。命令层 L5 三处散字面量收敛至此；
/// `is_cataloged` 原样透传（收录恒 L1 不会进此，签名保留防串）。
pub(crate) fn empty_cycle_result(is_cataloged: bool) -> IconCycleResult {
    IconCycleResult {
        url: String::new(),
        remote_url: String::new(),
        level: 5,
        source: "none".to_string(),
        is_fallback: true,
        total_levels: 5,
        is_cataloged,
    }
}

/// 有效图片文件读取唯一落点：存在 + 可读 + 非空 + 合法图片才返回字节。
pub(crate) fn read_valid_image_file(path: &std::path::Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    std::fs::read(path)
        .ok()
        .filter(|b| !b.is_empty() && crate::commands::icons::is_valid_image(b))
}

/// 最高频缓存读的 blocking 卸载：仅最高频 1-2 处经此异步入口（spawn_blocking），
/// 其余同步路径（read_level_cache_file / load_split_cached_bytes / 落盘写等）保持不动。
pub(crate) async fn read_valid_image_file_async(path: std::path::PathBuf) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || read_valid_image_file(&path))
        .await
        .ok()
        .flatten()
}

/// 落盘扩展名全集（读侧兜底 + 写侧残留清理用）：`infer` 白名单 + `mime_to_ext` 实产出
///（覆盖历史残留，避免暂定后缀纠正后旧文件常驻或重复下载）。
pub(crate) const KNOWN_ICON_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "apng", "bmp",
];

/// 指定级别缓存文件读取（非收录 `stem_l{level}.{ext}` 方案）：存在且有效才返回字节。
/// 先试 `inferred_ext`（快路径），miss 时遍历 [`KNOWN_ICON_EXTS`] 兜底，避免无后缀 URL
///（暂定 `png`）实际落盘为 `jpg` 后永远 miss 重复下载。
pub(crate) fn read_level_cache_file(
    icons_dir: &std::path::Path,
    stem: &str,
    level: i32,
    inferred_ext: &str,
) -> Option<Vec<u8>> {
    let fname = crate::db::icon_cycle::cycle_filename(stem, level, inferred_ext);
    if let Some(b) = read_valid_image_file(&icons_dir.join(fname)) {
        return Some(b);
    }
    for ext in KNOWN_ICON_EXTS {
        if *ext == inferred_ext {
            continue;
        }
        let alt = crate::db::icon_cycle::cycle_filename(stem, level, ext);
        if let Some(b) = read_valid_image_file(&icons_dir.join(alt)) {
            return Some(b);
        }
    }
    None
}

/// 两表分流缓存读取唯一落点（原 get_or_fetch_icon 内联分支，语义逐行对齐）：
/// 收录查 icon_cache_meta（要求文件非空 + meta URL 相等）；非收录查传入 cycle
///（要求 cache_file 非空 + selected_url 相点）。`noncatalog_cycle=None` 视为未命中。
/// 收录侧先试 `inferred_ext` 快路径，miss 时遍历 [`KNOWN_ICON_EXTS`] 兜底（meta URL 相等
/// 才算命中），避免暂定后缀与实际落盘不一致时每次 miss 重复下载。
pub(crate) fn load_split_cached_bytes(
    icons_dir: &std::path::Path,
    db: &crate::db::Database,
    stem: &str,
    inferred_ext: &str,
    url_trimmed: &str,
    is_cataloged: bool,
    noncatalog_cycle: Option<&crate::db::AppIconCycle>,
) -> Option<Vec<u8>> {
    if is_cataloged {
        let mut candidates: Vec<String> = Vec::with_capacity(KNOWN_ICON_EXTS.len() + 1);
        candidates.push(crate::db::icon_cycle::catalog_filename(stem, inferred_ext));
        for ext in KNOWN_ICON_EXTS {
            if *ext == inferred_ext {
                continue;
            }
            candidates.push(crate::db::icon_cycle::catalog_filename(stem, ext));
        }
        for filename in candidates {
            let cache_file = icons_dir.join(&filename);
            if cache_file.is_file() {
                if let Ok(meta) = std::fs::metadata(&cache_file) {
                    if meta.len() > 0 {
                        if let Ok(Some(recorded_url)) = db.get_icon_cache_url(&filename) {
                            if recorded_url.trim() == url_trimmed {
                                if let Some(b) = read_valid_image_file(&cache_file) {
                                    return Some(b);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    } else if let Some(cycle) = noncatalog_cycle {
        if !cycle.cache_file.is_empty() && cycle.selected_url.trim() == url_trimmed {
            return read_valid_image_file(&icons_dir.join(&cycle.cache_file));
        }
        None
    } else {
        None
    }
}

/// 同 stem 同 level 的旧后缀残留清理（非收录 `stem_l{level}.*`，缝内私有）：
/// 保留 `keep_filename`，其余 [`KNOWN_ICON_EXTS`] 变体存在即删，
/// 避免 `png` 暂定→`jpg` 纠正后双文件常驻。命令层不再直调，一律经 `persist_icon_bytes`。
fn cleanup_stale_cycle_variants(
    icons_dir: &std::path::Path,
    stem: &str,
    level: i32,
    keep_filename: &str,
) {
    for ext in KNOWN_ICON_EXTS {
        let alt = crate::db::icon_cycle::cycle_filename(stem, level, ext);
        if alt != keep_filename {
            let p = icons_dir.join(&alt);
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// 收录应用落盘唯一落点（缝内私有，原 get_or_fetch_icon 收录分支）：
/// `stem.real_ext` 落盘，陈旧 inferred 后缀文件清理 + icon_cache_meta 同步（改名时删旧键），
/// 返回最终文件名。全量清理同 stem 的其余 [`KNOWN_ICON_EXTS`] 变体文件 + 对应旧 meta 键。
/// 对外只经 `persist_icon_bytes`（单一写入路径），命令层不直调。
fn persist_catalog_icon(
    icons_dir: &std::path::Path,
    db_opt: Option<&crate::db::Database>,
    stem: &str,
    real_ext: &str,
    inferred_ext: &str,
    url_trimmed: &str,
    bytes: &[u8],
) -> String {
    let final_filename = crate::db::icon_cycle::catalog_filename(stem, real_ext);
    let _ = std::fs::write(icons_dir.join(&final_filename), bytes);

    let initial_filename = crate::db::icon_cycle::catalog_filename(stem, inferred_ext);
    if initial_filename != final_filename {
        let initial_cache_file = icons_dir.join(&initial_filename);
        if initial_cache_file.exists() {
            let _ = std::fs::remove_file(&initial_cache_file);
        }
    }
    // 全量残留清理：同 stem 其他后缀变体一并删除（存在即删），防历史双文件常驻。
    for ext in KNOWN_ICON_EXTS {
        let alt = crate::db::icon_cycle::catalog_filename(stem, ext);
        if alt != final_filename && alt != initial_filename {
            let p = icons_dir.join(&alt);
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    if let Some(db) = db_opt {
        if initial_filename != final_filename {
            let _ = db.delete_icon_cache_url(&initial_filename);
        }
        // 同步清理其余变体的旧 meta 键（存在即删，保持单 stem 单键）。
        for ext in KNOWN_ICON_EXTS {
            let alt = crate::db::icon_cycle::catalog_filename(stem, ext);
            if alt != final_filename && alt != initial_filename {
                let _ = db.delete_icon_cache_url(&alt);
            }
        }
        let _ = db.save_icon_cache_url(&final_filename, url_trimmed);
    }
    final_filename
}

/// 写侧单一写入路径（probe-vs-persist 缝收敛点，cycle 持久化合一）：
/// `icons/` 落盘 + `icon_cache_meta` 同步二合一，`catalog vs cycle` 文件名分流收敛在内。
/// - 收录：`{stem}.{real_ext}` + 全量旧后缀清理 + meta 单键同步（经缝内 `persist_catalog_icon`）；
/// - 非收录：`{stem}_l{level}.{real_ext}` + 同 level 旧后缀清理（经缝内 `cleanup_...`）。
/// `real_ext` 经字节嗅探纠正（`detect_image_mime/mime_to_ext`），`inferred` 仅作旧键清理用；
/// 调用方随后经 `seal_cycle_selection + upsert/set_selected` 固化行（`let _` 吞错）。
/// ADR-0010：stem 经 canonical id 派生（调用方 `get_icon_stem` 已归一）；level 纯L，via 正交。
pub(crate) fn persist_icon_bytes(
    icons_dir: &std::path::Path,
    db_opt: Option<&crate::db::Database>,
    stem: &str,
    level: i32,
    is_cataloged: bool,
    url_trimmed: &str,
    bytes: &[u8],
) -> String {
    let real_ext = crate::commands::icons::mime_to_ext(crate::commands::icons::detect_image_mime(
        bytes,
    ));
    let inferred_ext =
        crate::commands::icons::infer_icon_ext_from_url(url_trimmed).unwrap_or("png");
    if is_cataloged {
        persist_catalog_icon(
            icons_dir,
            db_opt,
            stem,
            real_ext,
            inferred_ext,
            url_trimmed,
            bytes,
        )
    } else {
        let fname = crate::db::icon_cycle::cycle_filename(stem, level, real_ext);
        let _ = std::fs::write(icons_dir.join(&fname), bytes);
        cleanup_stale_cycle_variants(icons_dir, stem, level, &fname);
        fname
    }
}

/// 非收录 cycle 行加载-or-新建唯一落点（get_or_fetch 直取路径用）。
/// `lookup_id` 保持调用方原始 trim 形态（与原内联 `db.get_icon_cycle(clean_id)` 键一致）；
/// 新建行 owner/repo 经 owner_repo_for_new_cycle 推导（与原内联逐字对齐）。
pub(crate) fn load_or_new_cycle(
    db: &crate::db::Database,
    lookup_id: &str,
) -> crate::db::AppIconCycle {
    db.get_icon_cycle(lookup_id)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            let (owner, repo) = crate::db::icon_cycle::owner_repo_for_new_cycle(lookup_id);
            crate::db::AppIconCycle::new(lookup_id, owner, repo)
        })
}

/// 匿名兜底探测唯一落点（原 get_or_fetch_icon 直取失败分支，语义逐行对齐）：
/// 无 token，只跑免鉴权级（Simple Icons L2），跳过 Trees 以保护匿名配额；
/// 经 `icon_fetch::probe_anon_simple` 深核单调（无分支循环浪费），命中即下载返回字节。
/// L4 不进匿名兜底（需网络详情链专属）。
pub(crate) async fn fetch_anon_probe_bytes(
    client: &reqwest::Client,
    state: &AppState,
    app_id_label: &str,
    owner: &str,
    repo: &str,
) -> Option<Vec<u8>> {
    let probed_url = crate::github::icon_fetch::probe_anon_simple(client, owner, repo).await?;
    log::debug!(
        "icon probe fallback hit app_id='{}' source=simple-icons url='{}'",
        app_id_label,
        crate::log_support::sanitize_url(&probed_url)
    );
    download_via_mirror(state, client, &probed_url).await.ok()
}

/// README 图标探测（L4 详情链专属适配器，不受流式核约束，需网络）。
/// L4=README现场扒：先读本地详情缓存 `readme_markdown`，再远端拉取；
/// 与 L2/L3-live 正交（L2/L3 经深核，L4 经此处）。
async fn probe_readme(
    client: &reqwest::Client,
    state: &AppState,
    token: Option<&str>,
    owner: &str,
    repo: &str,
    app_id: &str,
) -> String {
    // 1. 优先从 SQLite 本地详情缓存读取 readme_markdown
    if let Ok(db) = state.db() {
        if let Ok(Some(detail)) = db.get_cached_app_detail(app_id, None) {
            if !detail.readme_markdown.trim().is_empty() {
                let (logo, _) = crate::github::CatalogService::extract_and_strip_logo_from_readme(
                    &detail.readme_markdown,
                    owner,
                    repo,
                );
                if let Some(url) = logo {
                    if !url.trim().is_empty() {
                        return url;
                    }
                }
            }
        }
    }

    // 2. 远端拉取 README
    let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
    let mut req = client
        .get(&readme_url)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .header("Accept", "application/vnd.github.raw");
    if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
        req = req.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", tok.trim()),
        );
    }

    if let Ok(Ok(resp)) = tokio::time::timeout(api_timeout_or(std::time::Duration::from_secs(8)), req.send()).await {
        if resp.status().is_success() {
            if let Ok(raw_readme) = resp.text().await {
                let (logo, _) = crate::github::CatalogService::extract_and_strip_logo_from_readme(
                    &raw_readme,
                    owner,
                    repo,
                );
                if let Some(url) = logo {
                    return url;
                }
            }
        }
    }

    String::new()
}

/// 填充补全 1..4 各级可用 URL（详情/cycle 适配器，薄）：
/// - L1=官方：仅收录应用官方源填 `l1_url`（Curated Catalog 例外之 L1 填充）；
///   未收录永不填 L1（UI cycle 非收录 only）。
/// - L2/L3-live：经 `icon_fetch` 深核（`probe_l2_simple`/`probe_l3_trees`，
///   `buffered(3)`+验图+caps），不另写 naive 探；L3 无 token 直接跳过。
/// - L4=README现场扒：经本文件 `probe_readme`（详情链专属，需网络）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ensure_cycle_levels(
    cycle: &mut crate::db::AppIconCycle,
    state: &AppState,
    owner: &str,
    repo: &str,
    app_id: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) {
    let client = crate::commands::icons::icon_http_client();

    // 图标L1=官方：仅收录应用官方源填图标L1（l1_url）；未收录应用保持为空
    if is_cataloged && cycle.l1_url.trim().is_empty() {
        if let Some(item) = catalog_item {
            let u = item.icon.trim();
            if u.starts_with("http://") || u.starts_with("https://") {
                cycle.l1_url = u.to_string();
            }
        }
    }

    // 图标L2=品牌库：品牌库 Simple Icons（深核）
    let need_l2 = cycle.l2_url.trim().is_empty();
    // 图标L3=仓库：翻全家 Git Trees (有 token 才跑，深核)
    let need_l3 = token.filter(|t| !t.trim().is_empty()).is_some()
        && cycle.l3_url.trim().is_empty();
    // L4=README现场扒
    let need_l4 = cycle.l4_url.trim().is_empty();
    // L3 鉴权头与流式核同源（`token_headers`，Token 方案；旧 cycle Bearer 已收敛）。
    let slow_headers = token
        .filter(|t| !t.trim().is_empty())
        .map(|t| crate::github::http::token_headers(Some(t)));

    let (probed_l2, probed_l3, probed_l4) = tokio::join!(
        async {
            if need_l2 {
                crate::github::icon_fetch::probe_l2_simple(&client, owner, repo)
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l3 {
                crate::github::icon_fetch::probe_l3_trees(
                    &client,
                    slow_headers.as_ref(),
                    owner,
                    repo,
                )
                .await
                .unwrap_or_default()
            } else {
                String::new()
            }
        },
        async {
            if need_l4 {
                probe_readme(&client, state, token, owner, repo, app_id).await
            } else {
                String::new()
            }
        }
    );

    if need_l2 && !probed_l2.is_empty() {
        cycle.l2_url = probed_l2;
    }
    if need_l3 && !probed_l3.is_empty() {
        cycle.l3_url = probed_l3;
    }
    if need_l4 && !probed_l4.is_empty() {
        cycle.l4_url = probed_l4;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_source_and_fallback_mapping() {
        assert_eq!(source_for_level(1), "official");
        assert_eq!(source_for_level(2), "simple-icons");
        assert_eq!(source_for_level(3), "trees");
        assert_eq!(source_for_level(4), "readme");
        assert_eq!(source_for_level(5), "none");
        assert_eq!(source_for_level(0), "none");

        assert!(!is_fallback_for_level(1));
        assert!(is_fallback_for_level(2));
        assert!(is_fallback_for_level(3));
        assert!(is_fallback_for_level(4));
        assert!(is_fallback_for_level(5));
    }

    #[test]
    fn test_resolve_app_coord_variants() {
        // 1. 标准 owner/repo
        let (id, o, r) = resolve_app_coord("rustdesk/rustdesk").unwrap();
        assert_eq!(id, "rustdesk/rustdesk");
        assert_eq!(o, "rustdesk");
        assert_eq!(r, "rustdesk");

        // 2. 带大写 owner/repo
        let (id, o, r) = resolve_app_coord("RustDesk/RustDesk").unwrap();
        assert_eq!(id, "rustdesk/rustdesk");
        assert_eq!(o, "RustDesk");
        assert_eq!(r, "RustDesk");

        // 3. GitHub 完整 URL
        let (id, o, r) = resolve_app_coord("https://github.com/agalwood/Motrix").unwrap();
        assert_eq!(id, "agalwood/motrix");
        assert_eq!(o, "agalwood");
        assert_eq!(r, "Motrix");

        // 4. 前缀短语法
        let (id, o, r) = resolve_app_coord("gh:vlang/v").unwrap();
        assert_eq!(id, "vlang/v");
        assert_eq!(o, "vlang");
        assert_eq!(r, "v");

        // 5. 非法输入
        assert!(resolve_app_coord("").is_err());
        assert!(resolve_app_coord("   ").is_err());
        assert!(resolve_app_coord("justaname").is_err());
    }

    #[test]
    fn test_next_cycle_level_progression_and_wrap() {
        let mut cycle = crate::db::AppIconCycle {
            app_id: "test/test".to_string(),
            owner: "test".to_string(),
            repo: "test".to_string(),
            is_cataloged: true,
            level: 1,
            l1_url: "https://example.com/1.png".to_string(),
            l2_url: "https://example.com/2.png".to_string(),
            l3_url: "https://example.com/3.png".to_string(),
            l4_url: "https://example.com/4.png".to_string(),
            selected_url: "https://example.com/1.png".to_string(),
            cache_file: "test.png".to_string(),
            updated_at: 0,
        };

        // 全满时：1 -> 2 -> 3 -> 4 -> 5 -> 1
        assert_eq!(next_cycle_level(1, &cycle), 2);
        assert_eq!(next_cycle_level(2, &cycle), 3);
        assert_eq!(next_cycle_level(3, &cycle), 4);
        assert_eq!(next_cycle_level(4, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 存在空档时顺延：2 和 3 为空
        cycle.l2_url = "".to_string();
        cycle.l3_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 4);
        assert_eq!(next_cycle_level(4, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 仅图标L1=官方有效：1 -> 5 -> 1
        cycle.l4_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 1);

        // 1..4 全部为空：始终顺延到 5
        cycle.l1_url = "".to_string();
        assert_eq!(next_cycle_level(1, &cycle), 5);
        assert_eq!(next_cycle_level(5, &cycle), 5);

        // 非收录应用：1 档永远跳过，5 回绕到 2
        let non_cat = crate::db::AppIconCycle {
            app_id: "noncat/test".to_string(),
            owner: "noncat".to_string(),
            repo: "test".to_string(),
            is_cataloged: false,
            level: 2,
            l1_url: "".to_string(),
            l2_url: "https://example.com/2.png".to_string(),
            l3_url: "https://example.com/3.png".to_string(),
            l4_url: "https://example.com/4.png".to_string(),
            selected_url: "https://example.com/2.png".to_string(),
            cache_file: "test_l2.png".to_string(),
            updated_at: 0,
        };
        assert_eq!(next_cycle_level(2, &non_cat), 3);
        assert_eq!(next_cycle_level(3, &non_cat), 4);
        assert_eq!(next_cycle_level(4, &non_cat), 5);
        assert_eq!(next_cycle_level(5, &non_cat), 2);

        // 验证 first_available_level
        assert_eq!(first_available_level(&non_cat), Some(2));
        assert_eq!(first_available_level(&cycle), None);
    }

    #[test]
    fn test_two_table_split_db_behavior() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let cat_app = "rustdesk/rustdesk";
        let non_cat_app = "custom/unknown";

        // 1. 收录应用：写 icon_cache_meta 与 app_icon_cycles
        let cat_cycle = crate::db::AppIconCycle {
            app_id: cat_app.to_string(),
            owner: "rustdesk".to_string(),
            repo: "rustdesk".to_string(),
            is_cataloged: true,
            level: 1,
            l1_url: "https://example.com/l1.png".to_string(),
            selected_url: "https://example.com/l1.png".to_string(),
            cache_file: "rustdesk_rustdesk.png".to_string(),
            updated_at: 1000,
            ..Default::default()
        };
        db.upsert_icon_cycle(&cat_cycle).unwrap();
        db.save_icon_cache_url("rustdesk_rustdesk.png", "https://example.com/l1.png").unwrap();

        // 校验：收录应用在两表中均可查到
        assert_eq!(
            db.get_icon_cache_url("rustdesk_rustdesk.png").unwrap(),
            Some("https://example.com/l1.png".to_string())
        );
        let cat_res = db.get_icon_cycle(cat_app).unwrap().unwrap();
        assert!(cat_res.is_cataloged);
        assert_eq!(cat_res.cache_file, "rustdesk_rustdesk.png");

        // 2. 非收录应用：只走 app_icon_cycles，且文件名带 _l{level} 后缀
        let non_cat_cycle = crate::db::AppIconCycle {
            app_id: non_cat_app.to_string(),
            owner: "custom".to_string(),
            repo: "unknown".to_string(),
            is_cataloged: false,
            level: 2,
            l2_url: "https://cdn.simpleicons.org/custom".to_string(),
            selected_url: "https://cdn.simpleicons.org/custom".to_string(),
            cache_file: "custom_unknown_l2.png".to_string(),
            updated_at: 2000,
            ..Default::default()
        };
        db.upsert_icon_cycle(&non_cat_cycle).unwrap();

        // 校验：非收录应用绝不写入 icon_cache_meta
        assert_eq!(
            db.get_icon_cache_url("custom_unknown_l2.png").unwrap(),
            None
        );
        // 但在 app_icon_cycles 中完整保留
        let non_cat_res = db.get_icon_cycle(non_cat_app).unwrap().unwrap();
        assert!(!non_cat_res.is_cataloged);
        assert_eq!(non_cat_res.level, 2);
        assert_eq!(non_cat_res.cache_file, "custom_unknown_l2.png");
    }
}
