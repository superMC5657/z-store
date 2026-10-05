use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// ADR-0008：网络超时统一经 `get_project_config().network.api_timeout_seconds` 获取；
/// 配置为 0（未设置）时回退到调用方传入的历史硬编码值，行为保持不变。
fn api_timeout_or(fallback: std::time::Duration) -> std::time::Duration {
    let secs = crate::config::get_project_config()
        .network
        .api_timeout_seconds;
    if secs > 0 {
        std::time::Duration::from_secs(secs)
    } else {
        fallback
    }
}

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

/// 镜像改写唯一落点：头像 URL 永不走镜像；改写无变化时返回 None（调用方直连）。
/// 收敛原散落在 get_or_fetch_icon / cycle_app_icon / get_app_icon_cycle 的 5 处同形分支。
pub(crate) fn mirror_url_for(state: &AppState, url: &str) -> Option<String> {
    if super::is_avatar_url(url) {
        return None;
    }
    state.mirror.lock().ok().and_then(|m| {
        let rewritten = m.rewrite_download_url(url);
        if rewritten != url {
            Some(rewritten)
        } else {
            None
        }
    })
}

/// 有效图片文件读取唯一落点：存在 + 可读 + 非空 + 合法图片才返回字节。
pub(crate) fn read_valid_image_file(path: &std::path::Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    std::fs::read(path)
        .ok()
        .filter(|b| !b.is_empty() && super::is_valid_image(b))
}

/// 最高频缓存读的 blocking 卸载：仅最高频 1-2 处经此异步入口（spawn_blocking），
/// 其余同步路径（read_level_cache_file / load_split_cached_bytes / 落盘写等）保持不动。
async fn read_valid_image_file_async(path: std::path::PathBuf) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || read_valid_image_file(&path))
        .await
        .ok()
        .flatten()
}

/// 指定级别缓存文件读取（非收录 `stem_l{level}.{ext}` 方案）：存在且有效才返回字节。
pub(crate) fn read_level_cache_file(
    icons_dir: &std::path::Path,
    stem: &str,
    level: i32,
    inferred_ext: &str,
) -> Option<Vec<u8>> {
    let fname = crate::db::icon_cycle::cycle_filename(stem, level, inferred_ext);
    read_valid_image_file(&icons_dir.join(fname))
}

/// 两表分流缓存读取唯一落点（原 get_or_fetch_icon 内联分支，语义逐行对齐）：
/// 收录查 icon_cache_meta（要求文件非空 + meta URL 相等）；非收录查传入 cycle
///（要求 cache_file 非空 + selected_url 相等）。`noncatalog_cycle=None` 视为未命中。
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
        let filename = crate::db::icon_cycle::catalog_filename(stem, inferred_ext);
        let cache_file = icons_dir.join(&filename);
        if cache_file.is_file() {
            if let Ok(meta) = std::fs::metadata(&cache_file) {
                if meta.len() > 0 {
                    if let Ok(Some(recorded_url)) = db.get_icon_cache_url(&filename) {
                        if recorded_url.trim() == url_trimmed {
                            return read_valid_image_file(&cache_file);
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

/// 收录应用落盘唯一落点（原 get_or_fetch_icon 收录分支）：`stem.real_ext` 落盘，
/// 陈旧 inferred 后缀文件清理 + icon_cache_meta 同步（改名时删旧键），返回最终文件名。
pub(crate) fn persist_catalog_icon(
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

    if let Some(db) = db_opt {
        if initial_filename != final_filename {
            let _ = db.delete_icon_cache_url(&initial_filename);
        }
        let _ = db.save_icon_cache_url(&final_filename, url_trimmed);
    }
    final_filename
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
/// 无 token，只跑免鉴权级（Simple Icons），跳过 Trees 以保护匿名配额；
/// 先拿确切默认分支（匿名一次调用，失败则退化 main/master 双试），命中即下载返回字节。
pub(crate) async fn fetch_anon_probe_bytes(
    client: &reqwest::Client,
    state: &AppState,
    app_id_label: &str,
    owner: &str,
    repo: &str,
) -> Option<Vec<u8>> {
    let mut branches: Vec<String> = Vec::with_capacity(2);
    let repo_api = format!("https://api.github.com/repos/{}/{}", owner, repo);
    if let Ok(resp) = client
        .get(&repo_api)
        .header("User-Agent", crate::forge::http::BROWSER_UA_VALUE)
        .send()
        .await
    {
        if let Ok(v) = resp.json::<serde_json::Value>().await {
            if let Some(b) = v.get("default_branch").and_then(|x| x.as_str()) {
                branches.push(b.to_string());
            }
        }
    }
    branches.push("main".to_string());
    branches.push("master".to_string());
    let mut probed_url: Option<String> = None;
    for b in branches {
        if let Some(p) =
            crate::github::icon_probe::probe_repo_logo(client, None, owner, repo, &b).await
        {
            log::debug!(
                "icon probe fallback hit app_id='{}' source={} url='{}'",
                app_id_label,
                p.source,
                crate::log_support::sanitize_url(&p.url)
            );
            probed_url = Some(p.url);
            break;
        }
    }
    let purl = probed_url?;
    let probe_mirror = mirror_url_for(state, &purl);
    super::download_icon_bytes(client, probe_mirror.as_deref(), &purl)
        .await
        .ok()
}

/// 品牌库 Simple Icons 探测 (L2)
async fn probe_simple_icons(client: &reqwest::Client, owner: &str, repo: &str) -> String {
    let mut slugs = crate::github::icon_probe::derive_slugs(repo);
    for s in crate::github::icon_probe::derive_slugs(owner) {
        if !slugs.contains(&s) {
            slugs.push(s);
        }
    }
    if slugs.is_empty() {
        return String::new();
    }

    const BROWSER_UA: &str = crate::forge::http::BROWSER_UA_VALUE;
    let probe_timeout = api_timeout_or(std::time::Duration::from_secs(5));

    for slug in slugs {
        let cdn = format!("https://cdn.simpleicons.org/{}", slug);
        let req = client.get(&cdn).header("User-Agent", BROWSER_UA).send();
        if let Ok(Ok(resp)) = tokio::time::timeout(probe_timeout, req).await {
            if resp.status().is_success() {
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                if ctype.contains("svg")
                    || ctype.starts_with("image/")
                    || ctype.contains("octet-stream")
                {
                    if let Ok(bytes) = resp.bytes().await {
                        if bytes.len() >= 300 {
                            return cdn;
                        }
                    }
                }
            }
        }
    }
    String::new()
}

/// 翻全家 Git Trees 评分探测 (L3)
/// 有 token 才跑，无 token 则跳过返回空
async fn probe_git_trees(
    client: &reqwest::Client,
    token: Option<&str>,
    owner: &str,
    repo: &str,
) -> String {
    let Some(tok) = token.filter(|t| !t.trim().is_empty()) else {
        return String::new();
    };

    let mut hdrs = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
        hdrs.insert(reqwest::header::AUTHORIZATION, v);
    }
    hdrs.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(crate::forge::http::BROWSER_UA_VALUE),
    );

    let mut branches: Vec<String> = Vec::with_capacity(3);
    let repo_api = format!("https://api.github.com/repos/{}/{}", owner, repo);
    if let Ok(Ok(resp)) = tokio::time::timeout(
        api_timeout_or(std::time::Duration::from_secs(5)),
        client.get(&repo_api).headers(hdrs.clone()).send(),
    )
    .await
    {
        if let Ok(v) = resp.json::<serde_json::Value>().await {
            if let Some(b) = v.get("default_branch").and_then(|x| x.as_str()) {
                branches.push(b.to_string());
            }
        }
    }
    if !branches.iter().any(|b| b == "main") {
        branches.push("main".to_string());
    }
    if !branches.iter().any(|b| b == "master") {
        branches.push("master".to_string());
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

    // 首命中即停：命中直接返回，不补拉剩余分支；保持顺序逐分支试探，不做并发竞速。
    for branch in branches {
        let tree_url = format!(
            "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
            owner, repo, branch
        );
        let req = client.get(&tree_url).headers(hdrs.clone()).send();
        if let Ok(Ok(resp)) = tokio::time::timeout(api_timeout_or(std::time::Duration::from_secs(12)), req).await {
            if resp.status().is_success() {
                if let Ok(tree) = resp.json::<GitTree>().await {
                    let mut best: Option<(i32, u64, String)> = None;
                    for node in tree.tree.iter().filter(|n| {
                        n.node_type.as_deref() == Some("blob") && n.path.is_some()
                    }) {
                        let p = node.path.as_deref().unwrap_or("");
                        let s = crate::github::icon_probe::score_candidate(p, node.size, repo);
                        if s > 0 && node.size.is_none_or(|z| z >= 300) {
                            let cand = (s, node.size.unwrap_or(0), p.to_string());
                            if best.as_ref().is_none_or(|b| cand.0 > b.0 || (cand.0 == b.0 && cand.1 > b.1)) {
                                best = Some(cand);
                            }
                        }
                    }
                    if let Some((_, _, path)) = best {
                        return format!(
                            "https://raw.githubusercontent.com/{}/{}/{}/{}",
                            owner,
                            repo,
                            branch,
                            path.trim_start_matches('/')
                        );
                    }
                }
            }
        }
    }

    String::new()
}

/// README 图标探测 (L4)
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

/// 填充补全 1..4 各级可用 URL
#[allow(clippy::too_many_arguments)]
async fn ensure_cycle_levels(
    cycle: &mut crate::db::AppIconCycle,
    state: &AppState,
    owner: &str,
    repo: &str,
    app_id: &str,
    is_cataloged: bool,
    catalog_item: Option<&crate::github::CatalogItem>,
    token: Option<&str>,
) {
    let client = super::icon_http_client();

    // L1: 仅收录应用官方源填 L1；未收录应用保持为空
    if is_cataloged && cycle.l1_url.trim().is_empty() {
        if let Some(item) = catalog_item {
            let u = item.icon.trim();
            if u.starts_with("http://") || u.starts_with("https://") {
                cycle.l1_url = u.to_string();
            }
        }
    }

    // L2: 品牌库 Simple Icons
    let need_l2 = cycle.l2_url.trim().is_empty();
    // L3: 翻全家 Git Trees (有 token 才跑)
    let need_l3 = token.is_some() && cycle.l3_url.trim().is_empty();
    // L4: README
    let need_l4 = cycle.l4_url.trim().is_empty();

    let (probed_l2, probed_l3, probed_l4) = tokio::join!(
        async {
            if need_l2 {
                probe_simple_icons(&client, owner, repo).await
            } else {
                String::new()
            }
        },
        async {
            if need_l3 {
                probe_git_trees(&client, token, owner, repo).await
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

/// 循环切换应用图标 (L1..=L5)
#[tauri::command]
pub async fn cycle_app_icon(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();
    if is_cataloged {
        // 加固：收录应用直接返回当前 L1，不切换（防误调）
        return get_app_icon_cycle(state, app_id).await;
    }
    let token = crate::commands::resolve_active_github_token(&state);

    let icons_dir = crate::get_app_data_dir().join("icons");
    if !icons_dir.exists() {
        let _ = std::fs::create_dir_all(&icons_dir);
    }

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    let mut cycle = match existing {
        Some(mut c) => {
            ensure_cycle_levels(
                &mut c,
                &state,
                &owner,
                &repo,
                &canonical_id,
                is_cataloged,
                catalog_item.as_ref(),
                token.as_deref(),
            )
            .await;
            if !is_cataloged && c.level == 1 {
                c.level = first_available_level(&c).unwrap_or(2);
            }
            c
        }
        None => {
            let mut c = crate::db::AppIconCycle::new(&canonical_id, &owner, &repo);
            c.is_cataloged = is_cataloged;
            ensure_cycle_levels(
                &mut c,
                &state,
                &owner,
                &repo,
                &canonical_id,
                is_cataloged,
                catalog_item.as_ref(),
                token.as_deref(),
            )
            .await;
            c.level = if is_cataloged {
                1
            } else {
                first_available_level(&c).unwrap_or(2)
            };
            c
        }
    };

    // 计算下一个推进级别
    let next_level = next_cycle_level(cycle.level, &cycle);

    // Level 5: 空（始终可用，直接置空，无需下载）
    if next_level == 5 {
        cycle.level = 5;
        cycle.selected_url = String::new();
        cycle.cache_file = String::new();
        cycle.updated_at = crate::now_secs();
        if let Ok(db) = state.db() {
            let _ = db.upsert_icon_cycle(&cycle);
        }

        return Ok(IconCycleResult {
            url: String::new(),
            remote_url: String::new(),
            level: 5,
            source: "none".to_string(),
            is_fallback: true,
            total_levels: 5,
            is_cataloged: false,
        });
    }

    // Level 1..=4: 必须下载成功方可推进 level（下载失败不推进 level）
    let target_url = cycle
        .url_for_level(next_level)
        .unwrap_or("")
        .trim()
        .to_string();
    if target_url.is_empty() {
        return Err("目标级别无有效图标链接".into());
    }

    let stem = super::get_icon_stem(&canonical_id, &target_url);
    let client = super::icon_http_client();
    let mirror_url = mirror_url_for(&state, &target_url);

    // 检查本地是否已存在缓存文件（收录走两表分流读取；非收录按 stem_l{level}.{ext} 匹配）
    let inferred_ext = super::infer_icon_ext_from_url(&target_url).unwrap_or("png");
    let mut cached_bytes = if !is_cataloged {
        read_level_cache_file(&icons_dir, &stem, next_level, inferred_ext)
    } else {
        None
    };
    if cached_bytes.is_none() {
        if let Ok(db) = state.db() {
            if is_cataloged {
                cached_bytes =
                    load_split_cached_bytes(&icons_dir, &db, &stem, inferred_ext, &target_url, true, None);
            }
        }
    }

    let bytes = match cached_bytes {
        Some(b) => b,
        None => {
            // 从远端下载；若失败，不推进 level，直接返回 Err
            match super::download_icon_bytes(&client, mirror_url.as_deref(), &target_url).await {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(
                        "cycle_app_icon download failed id={} level={} target_url='{}' err={}",
                        canonical_id,
                        next_level,
                        crate::log_support::sanitize_url(&target_url),
                        e
                    );
                    return Err(e.into());
                }
            }
        }
    };

    let mime = super::detect_image_mime(&bytes);
    let real_ext = super::mime_to_ext(mime);

    // 两表分流持久化（文件名方案收敛至共享 helper；收录分支不可达，已收敛为 canonical 落盘语义）
    let db_opt = state.db().ok();
    let final_filename = if is_cataloged {
        // 收录应用：写 icon_cache_meta，文件名为 stem.ext
        persist_catalog_icon(
            &icons_dir,
            db_opt.as_deref(),
            &stem,
            real_ext,
            inferred_ext,
            &target_url,
            &bytes,
        )
    } else {
        // 非收录应用：只走 app_icon_cycles，文件名为 stem_l{level}.ext 隔离
        let fname = crate::db::icon_cycle::cycle_filename(&stem, next_level, real_ext);
        let fpath = icons_dir.join(&fname);
        let _ = std::fs::write(&fpath, &bytes);
        fname
    };

    crate::db::icon_cycle::seal_cycle_selection(&mut cycle, next_level, &target_url, final_filename);
    if let Some(db) = db_opt.as_ref() {
        let _ = db.upsert_icon_cycle(&cycle);
    }

    let data_uri = super::bytes_to_data_uri(&bytes);
    Ok(IconCycleResult {
        url: data_uri,
        remote_url: target_url,
        level: next_level,
        source: source_for_level(next_level).to_string(),
        is_fallback: is_fallback_for_level(next_level),
        total_levels: 5,
        is_cataloged: false,
    })
}

/// 只读恢复应用当前图标状态
#[tauri::command]
pub async fn get_app_icon_cycle(
    state: State<'_, AppState>,
    app_id: String,
) -> crate::AppResult<IconCycleResult> {
    let (canonical_id, owner, repo) = resolve_app_coord(&app_id)?;
    let catalog_item = state.catalog.get_catalog_item(&canonical_id);
    let is_cataloged = catalog_item.is_some();

    let icons_dir = crate::get_app_data_dir().join("icons");

    let existing = state
        .db()
        .ok()
        .and_then(|db| db.get_icon_cycle(&canonical_id).ok().flatten());

    if let Some(cycle) = existing {
        if cycle.level == 5 {
            return Ok(IconCycleResult {
                url: String::new(),
                remote_url: String::new(),
                level: 5,
                source: "none".to_string(),
                is_fallback: true,
                total_levels: 5,
                is_cataloged,
            });
        }

        let lvl = if !cycle.is_cataloged && cycle.level == 1 {
            first_available_level(&cycle).unwrap_or(2)
        } else {
            cycle.level
        };
        let remote_url = cycle
            .url_for_level(lvl)
            .filter(|u| !u.trim().is_empty())
            .unwrap_or(&cycle.selected_url)
            .to_string();

        if !cycle.cache_file.is_empty() {
            // 最高频读：经 spawn_blocking 卸载，避免阻塞 async 运行时。
            if let Some(bytes) =
                read_valid_image_file_async(icons_dir.join(&cycle.cache_file)).await
            {
                return Ok(IconCycleResult {
                    url: super::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged,
                });
            }
        }

        // 文件缺失但有 remote_url 时尝试恢复
        if !remote_url.is_empty() {
            let client = super::icon_http_client();
            let mirror_url = mirror_url_for(&state, &remote_url);
            if let Ok(bytes) = super::download_icon_bytes(&client, mirror_url.as_deref(), &remote_url).await {
                let mime = super::detect_image_mime(&bytes);
                let real_ext = super::mime_to_ext(mime);
                let stem = super::get_icon_stem(&canonical_id, &remote_url);
                let filename = if is_cataloged {
                    let fn_cat = crate::db::icon_cycle::catalog_filename(&stem, real_ext);
                    let _ = std::fs::write(icons_dir.join(&fn_cat), &bytes);
                    if let Ok(db) = state.db() {
                        let _ = db.save_icon_cache_url(&fn_cat, &remote_url);
                    }
                    fn_cat
                } else {
                    let fn_non = crate::db::icon_cycle::cycle_filename(&stem, lvl, real_ext);
                    let _ = std::fs::write(icons_dir.join(&fn_non), &bytes);
                    fn_non
                };

                if let Ok(db) = state.db() {
                    let _ = db.set_icon_cycle_selected(&canonical_id, lvl, &remote_url, &filename);
                }

                return Ok(IconCycleResult {
                    url: super::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged,
                });
            }
        }

        return Ok(IconCycleResult {
            url: String::new(),
            remote_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged,
        });
    }

    // 尚未记录过轮换状态：
    if is_cataloged {
        let default_url = catalog_item
            .as_ref()
            .map(|i| i.icon.trim().to_string())
            .unwrap_or_default();

        if !default_url.is_empty() {
            let stem = super::get_icon_stem(&canonical_id, &default_url);
            let inferred_ext = super::infer_icon_ext_from_url(&default_url).unwrap_or("png");
            let filename = crate::db::icon_cycle::catalog_filename(&stem, inferred_ext);
            // 最高频读其二：首屏收录图标恢复路径，同样经 spawn_blocking 卸载；其余同步读不动。
            if let Some(bytes) = read_valid_image_file_async(icons_dir.join(&filename)).await {
                return Ok(IconCycleResult {
                    url: super::bytes_to_data_uri(&bytes),
                    remote_url: default_url,
                    level: 1,
                    source: "official".to_string(),
                    is_fallback: false,
                    total_levels: 5,
                    is_cataloged: true,
                });
            }
        }

        // 初始状态且无本地缓存：返回 Level 1 与对应 remote_url
        let lvl = if default_url.is_empty() { 5 } else { 1 };
        return Ok(IconCycleResult {
            url: String::new(),
            remote_url: default_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged: true,
        });
    }

    // 未收录应用且未落库：调 ensure 后返回首个有效级别，无有效则走 L5 首字母徽章逻辑
    let token = crate::commands::resolve_active_github_token(&state);
    let mut temp_cycle = crate::db::AppIconCycle::new(&canonical_id, &owner, &repo);
    temp_cycle.is_cataloged = false;
    ensure_cycle_levels(
        &mut temp_cycle,
        &state,
        &owner,
        &repo,
        &canonical_id,
        false,
        None,
        token.as_deref(),
    )
    .await;

    if let Some(lvl) = first_available_level(&temp_cycle) {
        let remote_url = temp_cycle.url_for_level(lvl).unwrap_or("").trim().to_string();
        let stem = super::get_icon_stem(&canonical_id, &remote_url);
        let inferred_ext = super::infer_icon_ext_from_url(&remote_url).unwrap_or("png");
        if let Some(bytes) = read_level_cache_file(&icons_dir, &stem, lvl, inferred_ext) {
            return Ok(IconCycleResult {
                url: super::bytes_to_data_uri(&bytes),
                remote_url,
                level: lvl,
                source: source_for_level(lvl).to_string(),
                is_fallback: is_fallback_for_level(lvl),
                total_levels: 5,
                is_cataloged: false,
            });
        }

        // 文件缺失但有 remote_url 时尝试恢复
        if !remote_url.is_empty() {
            let client = super::icon_http_client();
            let mirror_url = mirror_url_for(&state, &remote_url);
            if let Ok(bytes) = super::download_icon_bytes(&client, mirror_url.as_deref(), &remote_url).await {
                let mime = super::detect_image_mime(&bytes);
                let real_ext = super::mime_to_ext(mime);
                let fn_non = crate::db::icon_cycle::cycle_filename(&stem, lvl, real_ext);
                let _ = std::fs::write(icons_dir.join(&fn_non), &bytes);
                crate::db::icon_cycle::seal_cycle_selection(
                    &mut temp_cycle,
                    lvl,
                    &remote_url,
                    fn_non.clone(),
                );
                if let Ok(db) = state.db() {
                    let _ = db.upsert_icon_cycle(&temp_cycle);
                }

                return Ok(IconCycleResult {
                    url: super::bytes_to_data_uri(&bytes),
                    remote_url,
                    level: lvl,
                    source: source_for_level(lvl).to_string(),
                    is_fallback: is_fallback_for_level(lvl),
                    total_levels: 5,
                    is_cataloged: false,
                });
            }
        }

        Ok(IconCycleResult {
            url: String::new(),
            remote_url,
            level: lvl,
            source: source_for_level(lvl).to_string(),
            is_fallback: is_fallback_for_level(lvl),
            total_levels: 5,
            is_cataloged: false,
        })
    } else {
        // 无有效则走 L5 首字母徽章逻辑
        Ok(IconCycleResult {
            url: String::new(),
            remote_url: String::new(),
            level: 5,
            source: "none".to_string(),
            is_fallback: true,
            total_levels: 5,
            is_cataloged: false,
        })
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

        // 仅 L1 有效：1 -> 5 -> 1
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
