use super::developer_profile::EtagGetOutcome;
use super::models::{GitHubAssetResponse, GitHubReleaseResponse, GitHubRepoResponse};
use super::CatalogService;
use crate::installer::InstallerEngine;
use crate::models::{AppDetail, ReleaseAsset};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, IF_NONE_MATCH};
use std::collections::HashMap;

impl CatalogService {
    pub async fn fetch_app_detail(
        &self,
        id: &str,
        cached_etag: Option<String>,
        cached_payload: Option<String>,
        cached_detail: Option<AppDetail>,
        token: Option<&str>,
    ) -> Result<(AppDetail, Option<(String, String)>), String> {
        let (owner, repo, name, desc, icon, icon_bg) = self.get_endpoints(id)?;
        let catalog_item = self
            .items
            .read()
            .ok()
            .and_then(|items| items.iter().find(|i| i.id == id).cloned());

        let client = &self.client;

        // H1/H2/H3：header/client/log 收敛为 github 内本地 helper，语义不变。
        let base_headers = super::http::token_headers(token);
        let mut headers = base_headers.clone();

        if let Some(ref etag) = cached_etag {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }

        let api_timeout = super::http::api_timeout();
        let release_url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
        let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let (req_id, sid) = super::http::new_log_ctx();
        // 首屏快速路径 (1)：release ∥ repo 并发发射。repo 仅需 owner/repo，
        // 与 release 响应无任何依赖，故两个原始请求同时在途，重叠 TLS 握手与首字节等待。
        // ETag/401/限流语义保持不变（ETag 经 get_with_etag 只挂 release，repo 照例无 IF_NONE_MATCH）。
        // H9：release 复用已有 get_with_etag（304/200/ETag 与 developer_* 共用实现）。
        let repo_headers_raw = base_headers.clone();
        let repo_url_raw = repo_url.clone();
        // H7/HttpSpan：repo 并发请求收敛为 forge HttpSpan（log_search_* 分支），
        // ETag 经 get_with_etag 只挂 release、repo 照例无 IF_NONE_MATCH 语义不变。
        let repo_span = crate::forge::http::HttpSpan::start(&repo_url_raw);
        repo_span.log_search_start("repo");
        let (release_outcome, repo_raw) = tokio::join!(
            Self::get_with_etag(
                client,
                &release_url,
                None,
                &base_headers,
                cached_etag.as_deref(),
                "detail-release",
            ),
            async {
                let req = client.get(&repo_url_raw).headers(repo_headers_raw).send();
                match tokio::time::timeout(api_timeout, req).await {
                    Ok(Ok(r)) => Some(r),
                    Ok(Err(e)) => {
                        repo_span.log_search_fail("repo", &e.to_string());
                        None
                    }
                    Err(_) => {
                        repo_span.log_search_fail("repo", "timeout");
                        None
                    }
                }
            }
        );
        // repo 原始响应的 401/限流处理与日志（与原 repo_task 内逻辑一致，仅提前到与 release 同批返回后处理）。
        // H7：401 经 crate::check_auth_expired 统一通知 + warn；日志经 HttpSpan 统一收敛。
        let repo_info: Option<GitHubRepoResponse> = match repo_raw {
            Some(res) => {
                repo_span.notify(&res, "github.com");
                crate::check_auth_expired(
                    res.status().as_u16(),
                    &format!("op=detail-repo id={}", id),
                );
                let status = res.status().as_u16();
                repo_span.log_search_done("repo", status);
                if res.status().is_success() {
                    res.json::<GitHubRepoResponse>().await.ok()
                } else {
                    None
                }
            }
            // 失败已在并发 future 内经 log_search_fail 落盘，此处不再重复 warn。
            None => None,
        };

        // H7：release 401 统一经 crate::check_auth_expired 通知；H9 的 get_with_etag 已做限流上报。
        let is_auth_unauthorized = matches!(release_outcome, EtagGetOutcome::Unauthorized);
        if is_auth_unauthorized {
            crate::notify_auth_expired();
        }

        // 核心提速门禁：若 GitHub 返回 304 Not Modified（说明最新 Release 版本完全未变）
        // 且本地已有完整缓存详情，直接零网络开销复用已有 README 与 Release 资产，实现 ~50ms 闪电响应
        // H8：时间戳收敛为 github 内 now_secs()。
        if matches!(release_outcome, EtagGetOutcome::NotModified) {
            if let Some(ref existing) = cached_detail {
                if !existing.releases.is_empty() && !existing.readme_markdown.trim().is_empty() {
                    let mut detail = existing.clone();
                    detail.releases.retain(|r| is_valid_installer_asset(&r.name, r.size_bytes));
                    let deduced = platforms_from_assets(&detail.releases);
                    detail.platforms = if deduced.is_empty() {
                        Vec::new()
                    } else if let Some(ref item) = catalog_item {
                        let mut set = std::collections::BTreeSet::new();
                        for p in &deduced {
                            set.insert(p.clone());
                        }
                        for p in &item.platforms {
                            if p == "ios" {
                                set.insert(p.clone());
                            }
                        }
                        let mut list: Vec<String> = set.into_iter().collect();
                        sort_platforms(&mut list);
                        list
                    } else {
                        deduced
                    };
                    if let Some(ref item) = catalog_item {
                        if item.description_en.is_some() {
                            detail.description_en = item.description_en.clone();
                        }
                    }
                    detail.cached_at = Some(super::http::now_secs());
                    detail.is_stale = None;
                    return Ok((detail, None));
                }
            }
        }

        let (release_resp, new_cache) = match release_outcome {
            EtagGetOutcome::NotModified => {
                // 304 Not Modified 但本地缺乏完整 cached_detail 时回退走 payload_json 恢复
                if let Some(ref payload) = cached_payload {
                    let parsed: GitHubReleaseResponse = serde_json::from_str(payload)
                        .map_err(|e| format!("解析本地 ETag 缓存失败: {}", e))?;
                    (parsed, None)
                } else {
                    return Err("304 响应但本地未找到缓存数据".to_string());
                }
            }
            EtagGetOutcome::Fresh { text, etag } => {
                let parsed: GitHubReleaseResponse = serde_json::from_str(&text)
                    .map_err(|e| format!("解析 GitHub Release 失败: {}", e))?;

                let cache_tuple = etag.map(|et| (et, text));
                (parsed, cache_tuple)
            }
            EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed => {
                // 离线或网络异常回退：若有 cached_detail 直接使用
                if let Some(mut existing) = cached_detail {
                    if let Some(ref item) = catalog_item {
                        if item.description_en.is_some() {
                            existing.description_en = item.description_en.clone();
                        }
                    }
                    existing.is_stale = Some(true);
                    return Ok((existing, None));
                }
                if let Some(ref payload) = cached_payload {
                    let parsed: GitHubReleaseResponse = serde_json::from_str(payload)
                        .map_err(|e| format!("解析离线缓存失败: {}", e))?;
                    (parsed, None)
                } else {
                    let fallback_ver = catalog_item
                        .as_ref()
                        .map(|i| i.default_version.clone())
                        .unwrap_or_else(|| "v1.0.0".to_string());
                    let fallback_body = if is_auth_unauthorized {
                        "GitHub 登录凭据已失效 (401)，暂无法同步最新 Release 发布产物。请重新登录授权。".to_string()
                    } else {
                        "离线模式，暂无法直连获取 GitHub Release 变更日志。".to_string()
                    };
                    (
                        GitHubReleaseResponse {
                            tag_name: fallback_ver,
                            body: Some(fallback_body),
                            assets: Vec::new(),
                        },
                        None,
                    )
                }
            }
        };

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

        // 首屏快速路径 (2)：checksum 不再参与网络 join（lazy 到 detail 成形之后，
        // 以 3s 硬超时 opportunistic 填充）；此处仅准备 readme 请求。
        let readme_url = format!("https://api.github.com/repos/{}/{}/readme", owner, repo);
        let mut readme_headers = headers.clone();
        readme_headers.remove(IF_NONE_MATCH);
        readme_headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3.raw"),
        );
        let default_readme = format!("# {}\n\n{}", name, desc);
        let default_readme_clone = default_readme.clone();
        // 显式克隆 sid/req/id 供 async 块内日志使用（不碰 thread-local，不改并发）。
        let readme_id = id.to_string();
        let readme_sid = sid.clone();
        let readme_req = req_id.clone();
        let readme_task = async {
            // 版本未发生变动且已有 README 缓存，不重复发网络请求拉取
            if !version_changed && has_cached_readme {
                if let Some(r) = cached_readme {
                    return r;
                }
            }
            log::debug!(
                "http get readme id={} sid={} req={} url='{}'",
                readme_id,
                readme_sid,
                readme_req,
                crate::log_support::sanitize_url(&readme_url)
            );
            let start_readme = std::time::Instant::now();
            let req = client.get(&readme_url).headers(readme_headers).send();
            match tokio::time::timeout(api_timeout, req).await {
                Ok(Ok(res)) => {
                    crate::notify_rate_limit("github.com", res.headers());
                    crate::check_auth_expired(
                        res.status().as_u16(),
                        &format!("op=detail-readme id={}", readme_id),
                    );
                    let status = res.status().as_u16();
                    log::debug!(
                        "http resp readme id={} sid={} req={} url='{}' status={} elapsed_ms={}",
                        readme_id,
                        readme_sid,
                        readme_req,
                        crate::log_support::sanitize_url(&readme_url),
                        status,
                        start_readme.elapsed().as_millis()
                    );
                    log::info!(
                        "http resp readme id={} sid={} req={} host={} status={} elapsed_ms={}",
                        readme_id,
                        readme_sid,
                        readme_req,
                        crate::log_support::host_of(&readme_url),
                        status,
                        start_readme.elapsed().as_millis()
                    );
                    if res.status().is_success() {
                        res.text().await.unwrap_or(default_readme_clone)
                    } else {
                        default_readme_clone
                    }
                }
                _ => {
                    log::warn!(
                        "http resp readme failed id={} sid={} req={} host={} elapsed_ms={}",
                        readme_id,
                        readme_sid,
                        readme_req,
                        crate::log_support::host_of(&readme_url),
                        start_readme.elapsed().as_millis()
                    );
                    default_readme_clone
                }
            }
        };

        // 首屏快速路径 (2 续)：repo 已在上游与 release 并发取得（见本函数首部），
        // 此处 join 仅 await readme；checksum 不阻塞首屏。
        let raw_readme = readme_task.await;

        let latest_stars = repo_info
            .as_ref()
            .and_then(|r| r.stargazers_count)
            .or_else(|| catalog_item.as_ref().map(|i| i.stars))
            .unwrap_or(0);

        let latest_forks = repo_info
            .as_ref()
            .and_then(|r| r.forks_count)
            .or_else(|| catalog_item.as_ref().map(|i| i.forks))
            .unwrap_or(0);

        let latest_license = repo_info
            .as_ref()
            .and_then(|r| r.license.as_ref())
            .and_then(|l| l.spdx_id.clone())
            .or_else(|| catalog_item.as_ref().map(|i| i.license.clone()))
            .unwrap_or_else(|| "FLOSS".to_string());

        let latest_homepage = repo_info
            .as_ref()
            .and_then(|r| r.homepage.clone())
            .filter(|h| !h.trim().is_empty())
            .or_else(|| catalog_item.as_ref().and_then(|i| i.homepage.clone()))
            .filter(|h| !h.trim().is_empty())
            .map(|h| {
                let trimmed = h.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    trimmed.to_string()
                } else {
                    format!("https://{}", trimmed)
                }
            });

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

        // 首屏快速路径 (3)：校验和延迟惰性填充（仅提供机会性完整性保障）。
        // 信任模型：校验和仅作为机会性完整性参考（条目常为仅限 Linux 的单文件），
        // 安全根基是下载时的 SHA-256 强校验；因此跳过/超时均安全，直接以 sha256=None 落库。
        // 消极缓存（Negative Cache）：调用方（commands/catalog.rs save 路径）将本 detail 整体落库，
        // 全空 sha256 + 较新的 cached_at 即为标记；下次 cache=miss 若版本未变且在 24 小时内，
        // 直接命中消极缓存从而跳过本次抓取（见下方 negative_hit 分支），不再为仅限 Linux 的小文件阻塞等待。
        // H8：时间戳收敛为 github 内 now_secs()。
        let now_secs = super::http::now_secs();
        let negative_hit = !version_changed
            && cached_detail
                .as_ref()
                .map(|c| {
                    let fresh = c
                        .cached_at
                        .map(|t| now_secs - t < 24 * 3600)
                        .unwrap_or(false);
                    fresh && !c.releases.is_empty() && c.releases.iter().all(|r| r.sha256.is_none())
                })
                .unwrap_or(false);
        let checksums = if negative_hit {
            log::debug!(
                "checksum skip id={} sid={} req={} reason=negative_cache_hit_24h",
                id,
                sid,
                req_id
            );
            HashMap::new()
        } else {
            Self::extract_checksums_map(&release_resp.assets, client, &headers, id, &sid, &req_id)
                .await
        };

        let mut releases = Vec::new();
        for asset in release_resp.assets {
            // 安装包校验过滤：排除 .sha256/.sig/.txt、过滤 <=1MB 占位包、排除源码包
            if !is_valid_installer_asset(&asset.name, asset.size) {
                continue;
            }

            let (kind, os, arch) = InstallerEngine::classify_asset(&asset.name);
            let kind_str = match kind {
                crate::installer::AssetKind::Msi => "msi",
                crate::installer::AssetKind::SetupExe => "setup_exe",
                crate::installer::AssetKind::PortableZip => "portable_zip",
                crate::installer::AssetKind::Deb => "deb",
                crate::installer::AssetKind::Rpm => "rpm",
                crate::installer::AssetKind::AppImage => "appimage",
                crate::installer::AssetKind::Dmg => "dmg",
                crate::installer::AssetKind::Pkg => "pkg",
                crate::installer::AssetKind::Apk => "apk",
                crate::installer::AssetKind::Other => {
                    if asset.name.to_lowercase().ends_with(".msix") {
                        "setup_exe"
                    } else {
                        "other"
                    }
                }
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

        // 从经校验的有效发布资产中推断平台；无有效安装包则置空，避免虚假发布
        let deduced_platforms = platforms_from_assets(&releases);
        let final_platforms = if deduced_platforms.is_empty() {
            Vec::new()
        } else if let Some(ref item) = catalog_item {
            let mut set = std::collections::BTreeSet::new();
            for p in &deduced_platforms {
                set.insert(p.clone());
            }
            for p in &item.platforms {
                if p == "ios" {
                    set.insert(p.clone());
                }
            }
            let mut list: Vec<String> = set.into_iter().collect();
            sort_platforms(&mut list);
            list
        } else {
            deduced_platforms
        };

        // 图标层级决策：收录官方 → 品牌库 Simple Icons → 翻全家 Git Trees → README logo → 空。
        // 1. 已具备已知独立官方图标则保持，避免被误覆盖；
        // 2. 否则进入探测链（Simple Icons → Git Trees 全库评分）；
        // 3. 探测未命中则采用 README 提取并清洗出的 Logo；
        // 4. 全未命中兜底返回空字符串（前端降级为首字母徽章）。
        let final_icon = if icon.starts_with("http://") || icon.starts_with("https://") {
            icon
        } else {
            let branch = repo_info
                .as_ref()
                .and_then(|r| r.default_branch.clone())
                .unwrap_or_else(|| "HEAD".to_string());
            if let Some(probed) = super::icon_probe::probe_repo_logo(client, Some(&base_headers), &owner, &repo, &branch).await {
                log::debug!("icon probe hit id={} source={} url='{}'", id, probed.source, crate::log_support::sanitize_url(&probed.url));
                probed.url
            } else if let Some(logo) = extracted_logo {
                logo
            } else {
                String::new()
            }
        };

        let detail = AppDetail {
            id: id.to_string(),
            name,
            description_en: catalog_item.as_ref().and_then(|i| i.description_en.clone()),
            owner,
            repo,
            icon: final_icon,
            icon_bg,
            description: desc,
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
            cached_at: Some(super::http::now_secs()),
            is_stale: None,
            homepage: latest_homepage,
            platforms: final_platforms,
        };

        Ok((detail, new_cache))
    }

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
            let (eligible, reason) = Self::checksum_asset_platform_eligible(&n);
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
        // 镜像改写（等价 MirrorManager::rewrite_download_url 语义）：CatalogService 够不到
        // AppState 中的 MirrorManager，故用 gh-proxy 前缀兜底加速 GitHub 官方小文件。
        let (effective_url, is_mirror) =
            Self::rewrite_checksum_url_with_fallback(&asset.browser_download_url);
        let safe_url = crate::log_support::sanitize_url(&asset.browser_download_url);
        let safe_effective = crate::log_support::sanitize_url(&effective_url);
        let host = crate::log_support::host_of(&effective_url);
        log::debug!(
            "checksum fetch start id={} sid={} req={} file='{}' bytes={} url='{}' effective='{}' mirror={}",
            app_id,
            sid,
            req_id,
            file_name,
            file_bytes,
            safe_url,
            safe_effective,
            is_mirror
        );
        // 3s 硬超时：checksum 为 opportunistic 填充，绝不允许 10s 级阻塞首屏。
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

    /// checksum 文件名平台相关性判定（入参须为小写文件名）。
    /// Windows 相关（msi/exe/zip/setup/portable/win）或通用命名时返回 true；
    /// 携带 linux/mac/dmg/appimage/deb/rpm/aarch64/arm64/darwin 任一提示词时返回 false 及命中的提示词。
    fn checksum_asset_platform_eligible(lower_name: &str) -> (bool, &'static str) {
        const WIN_HINTS: &[&str] = &["msi", "exe", "zip", "setup", "portable", "win"];
        if WIN_HINTS.iter().any(|h| lower_name.contains(*h)) {
            return (true, "windows_relevant");
        }
        const NON_WIN_HINTS: &[&str] = &[
            "linux", "mac", "dmg", "appimage", "deb", "rpm", "aarch64", "arm64", "darwin",
        ];
        for hint in NON_WIN_HINTS {
            if lower_name.contains(*hint) {
                return (false, hint);
            }
        }
        (true, "generic")
    }

    /// checksum 下载地址镜像改写（`MirrorManager::rewrite_download_url` 的无状态等价实现）。
    /// `CatalogService` 够不到 `AppState` 中的 `MirrorManager`，故对 GitHub 官方小文件
    /// 直接套用 `gh-proxy` 前缀兜底；非 GitHub 域保持直连。
    fn rewrite_checksum_url_with_fallback(raw_url: &str) -> (String, bool) {
        if !crate::mirror::is_github_domain(raw_url) {
            return (raw_url.to_string(), false);
        }
        let wrapped = crate::mirror::wrap_gh_proxy(raw_url);
        let changed = wrapped != raw_url;
        (wrapped, changed)
    }

    /// 判断资产是否为可安装的有效二进制发布包（对齐 catalog 仓 checkBinary 规则）
    pub fn is_valid_installer_asset(name: &str, size_bytes: u64) -> bool {
        is_valid_installer_asset(name, size_bytes)
    }

    /// 从发布资产列表中推断平台（带安装包校验规则过滤）
    pub fn platforms_from_assets(assets: &[ReleaseAsset]) -> Vec<String> {
        platforms_from_assets(assets)
    }

    /// deduce 别名（兼容调用规范）
    pub fn deduce_platforms(assets: &[ReleaseAsset]) -> Vec<String> {
        deduce_platforms(assets)
    }
}

/// 1MB 门禁阈值（对齐 catalog 仓 checkBinary）
pub const ONE_MB_BYTES: u64 = 1024 * 1024;

/// 判断文件名是否为排除的校验和、签名或轻量元数据文件
pub fn is_excluded_signature_or_text(name_lower: &str) -> bool {
    const EXCLUDED_SUFFIXES: &[&str] = &[
        ".sha256", ".sha512", ".sha1", ".md5",
        ".sig", ".asc",
        ".txt", ".md",
        ".json", ".yml", ".yaml", ".xml",
        ".sbom", ".blockmap", ".zsync",
    ];
    if EXCLUDED_SUFFIXES.iter().any(|s| name_lower.ends_with(s)) {
        return true;
    }
    // 聚合校验和文件名判定（如 SHA256SUMS 等）
    if name_lower.contains("checksum")
        || name_lower.contains("sha256sum")
        || name_lower.contains("sha512sum")
        || name_lower.contains("md5sum")
    {
        return true;
    }
    false
}

/// 判断是否为源码包（源码归档或含源码标记的包，不可作为安装包）
pub fn is_source_package(name_lower: &str) -> bool {
    // 源码归档扩展名（.tar.gz/.tar.xz/.tgz 等在 GitHub Release 常为源码打包，且安装引擎不执行 tar 解压）
    if name_lower.ends_with(".tar.gz")
        || name_lower.ends_with(".tar.xz")
        || name_lower.ends_with(".tar.bz2")
        || name_lower.ends_with(".tgz")
        || name_lower.ends_with(".tar")
    {
        return true;
    }
    // 包含 source/sources 命名标记
    if name_lower.contains("source") || name_lower.contains("sources") {
        return true;
    }
    // 包含 src 关键字命名标记（如 app-src.zip, app_src.zip, src.zip 等）
    if name_lower.contains("-src.")
        || name_lower.contains("_src.")
        || name_lower.contains(".src.")
        || name_lower.starts_with("src.")
        || name_lower.starts_with("src-")
        || name_lower.ends_with("-src.zip")
        || name_lower.ends_with("_src.zip")
    {
        return true;
    }
    false
}

/// 判断资产是否为有效可安装的二进制分发包（对齐 catalog 仓 checkBinary）：
/// 1. 过滤 <= 1MB (1_048_576 字节) 占位包与小文件；
/// 2. 排除 .sha256/.sig/.txt 及类似校验、签名、元数据文件；
/// 3. 排除源码包（含有 source/src 标记或 .tar.gz 归档等）；
/// 4. 认可 exe/msi/msix/dmg/pkg/AppImage/deb/rpm/apk 及非源码便携 zip。
pub fn is_valid_installer_asset(name: &str, size_bytes: u64) -> bool {
    if size_bytes <= ONE_MB_BYTES {
        return false;
    }
    let lower = name.to_lowercase();
    if is_excluded_signature_or_text(&lower) {
        return false;
    }
    if is_source_package(&lower) {
        return false;
    }
    let (kind, _, _) = InstallerEngine::classify_asset(name);
    match kind {
        crate::installer::AssetKind::Msi
        | crate::installer::AssetKind::SetupExe
        | crate::installer::AssetKind::Dmg
        | crate::installer::AssetKind::Pkg
        | crate::installer::AssetKind::AppImage
        | crate::installer::AssetKind::Deb
        | crate::installer::AssetKind::Rpm
        | crate::installer::AssetKind::Apk => true,
        crate::installer::AssetKind::PortableZip => true,
        crate::installer::AssetKind::Other => {
            // msix 扩展名特殊兼容支持
            lower.ends_with(".msix")
        }
    }
}

/// 根据资产列表推断支持的平台（带安装包校验规则过滤）。
/// 源码包、<=1MB 占位包、.sha256/.sig/.txt 均不算可安装资产；
/// 若无任何有效可安装包，则返回空列表（避免虚假发布）。
pub fn platforms_from_assets(assets: &[ReleaseAsset]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for a in assets {
        if !is_valid_installer_asset(&a.name, a.size_bytes) {
            continue;
        }
        let (_, os, _) = InstallerEngine::classify_asset(&a.name);
        if os != "all" {
            set.insert(os.to_string());
        } else if a.name.to_lowercase().ends_with(".msix") {
            set.insert("windows".to_string());
        }
    }
    let mut plats: Vec<String> = set.into_iter().collect();
    sort_platforms(&mut plats);
    plats
}

/// 别名 deduce_platforms / platforms_from_assets 对齐
pub fn deduce_platforms(assets: &[ReleaseAsset]) -> Vec<String> {
    platforms_from_assets(assets)
}

pub(crate) fn sort_platforms(platforms: &mut Vec<String>) {
    const ORDER: &[&str] = &["windows", "macos", "linux", "ios", "android"];
    platforms.sort_by_key(|p| {
        ORDER.iter().position(|&x| x == p.as_str()).unwrap_or(99)
    });
}

#[cfg(test)]
mod detail_fast_path_tests {
    use super::CatalogService;

    #[test]
    fn test_checksum_platform_filter_skips_linux_aarch64_only() {
        // FreeCAD 案：Linux-aarch64-only 的 checksum 文件必须跳过，不产生请求。
        let (ok, _) =
            CatalogService::checksum_asset_platform_eligible("freecad-linux-aarch64.sha256");
        assert!(!ok);
        let (ok, _) =
            CatalogService::checksum_asset_platform_eligible("app-1.0-linux.tar.gz.sha256");
        assert!(!ok);
        // Windows 相关与通用命名允许请求。
        let (ok, reason) =
            CatalogService::checksum_asset_platform_eligible("rustdesk-1.2.6-windows-msi.sha256");
        assert!(ok, "{}", reason);
        let (ok, reason) = CatalogService::checksum_asset_platform_eligible("checksums-sha256.txt");
        assert!(ok, "{}", reason);
        let (ok, _) = CatalogService::checksum_asset_platform_eligible("SHA256SUMS");
        assert!(ok);
    }

    #[test]
    fn test_checksum_mirror_fallback_rewrites_github_only() {
        let raw = "https://github.com/o/r/releases/download/v1/f.sha256";
        let (effective, mirror) = CatalogService::rewrite_checksum_url_with_fallback(raw);
        assert!(mirror);
        assert!(effective.starts_with("https://gh-proxy.com/https://github.com"));
        // 非 GitHub 域保持直连。
        let cb = "https://codeberg.org/attachments/f.sha256";
        let (effective, mirror) = CatalogService::rewrite_checksum_url_with_fallback(cb);
        assert!(!mirror);
        assert_eq!(effective, cb);
    }

    #[test]
    fn test_is_valid_installer_asset_filters() {
        use super::{is_valid_installer_asset, ONE_MB_BYTES};

        // 1. <= 1MB 占位包与小文件被过滤
        assert!(!is_valid_installer_asset("app-setup.exe", ONE_MB_BYTES));
        assert!(!is_valid_installer_asset("app-setup.exe", 500_000));
        assert!(!is_valid_installer_asset("app.deb", 1024));

        // 2. 校验和、签名、元数据被过滤
        assert!(!is_valid_installer_asset("app.exe.sha256", 5_000_000));
        assert!(!is_valid_installer_asset("app.sig", 5_000_000));
        assert!(!is_valid_installer_asset("app.asc", 5_000_000));
        assert!(!is_valid_installer_asset("release-notes.txt", 5_000_000));
        assert!(!is_valid_installer_asset("SHA256SUMS", 5_000_000));
        assert!(!is_valid_installer_asset("checksums.txt", 5_000_000));

        // 3. 源码包不可作为安装包
        assert!(!is_valid_installer_asset("app-1.0.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset("source.tar.gz", 25_000_000));
        assert!(!is_valid_installer_asset("sources.tar.xz", 25_000_000));
        assert!(!is_valid_installer_asset("app-source.zip", 25_000_000));
        assert!(!is_valid_installer_asset("app-src.zip", 25_000_000));
        assert!(!is_valid_installer_asset("src.zip", 25_000_000));

        // 4. 认可的主流二进制安装包
        assert!(is_valid_installer_asset("RustDesk-1.2.6-Setup.exe", 20_000_000));
        assert!(is_valid_installer_asset("vlc-3.0.21-win64.msi", 40_000_000));
        assert!(is_valid_installer_asset("app.msix", 30_000_000));
        assert!(is_valid_installer_asset("KeePassXC-2.7.9.dmg", 50_000_000));
        assert!(is_valid_installer_asset("Wireshark-4.2.4.pkg", 60_000_000));
        assert!(is_valid_installer_asset("LocalSend-1.15.2.AppImage", 35_000_000));
        assert!(is_valid_installer_asset("obs-studio_30.1.2_amd64.deb", 70_000_000));
        assert!(is_valid_installer_asset("rustdesk-1.2.6.rpm", 30_000_000));
        assert!(is_valid_installer_asset("app-release.apk", 15_000_000));
        assert!(is_valid_installer_asset("app-windows-x64.zip", 15_000_000));
    }

    #[test]
    fn test_platforms_from_assets_empty_on_source_and_invalid() {
        use super::platforms_from_assets;
        use crate::models::ReleaseAsset;

        fn make_asset(name: &str, size_bytes: u64) -> ReleaseAsset {
            ReleaseAsset {
                name: name.to_string(),
                download_url: "https://example.com/download".to_string(),
                size_bytes,
                sha256: None,
                os: String::new(),
                arch: String::new(),
                kind: String::new(),
            }
        }

        // 纯源码包：platforms 必须置空
        let source_only = vec![
            make_asset("app-1.0.tar.gz", 20_000_000),
            make_asset("app-source.zip", 15_000_000),
        ];
        assert!(platforms_from_assets(&source_only).is_empty());

        // 纯校验和与文档：platforms 必须置空
        let docs_only = vec![
            make_asset("checksums.txt", 5_000_000),
            make_asset("app.sig", 2_000_000),
        ];
        assert!(platforms_from_assets(&docs_only).is_empty());

        // 占位包 (<= 1MB)：platforms 必须置空
        let stub_only = vec![make_asset("app-setup.exe", 500_000)];
        assert!(platforms_from_assets(&stub_only).is_empty());

        // 空资产列表：platforms 必须置空
        assert!(platforms_from_assets(&[]).is_empty());
    }

    #[test]
    fn test_platforms_from_assets_derives_valid_platforms() {
        use super::{deduce_platforms, platforms_from_assets};
        use crate::models::ReleaseAsset;

        fn make_asset(name: &str, size_bytes: u64) -> ReleaseAsset {
            ReleaseAsset {
                name: name.to_string(),
                download_url: "https://example.com/download".to_string(),
                size_bytes,
                sha256: None,
                os: String::new(),
                arch: String::new(),
                kind: String::new(),
            }
        }

        let mixed = vec![
            make_asset("app-setup.exe", 20_000_000),
            make_asset("app_amd64.deb", 25_000_000),
            make_asset("app.dmg", 30_000_000),
            make_asset("app.tar.gz", 15_000_000), // 源码包，被过滤
            make_asset("app.sig", 5_000),          // 签名，被过滤
            make_asset("stub.exe", 500_000),       // <= 1MB，被过滤
        ];

        let plats = platforms_from_assets(&mixed);
        assert_eq!(plats, vec!["windows".to_string(), "macos".to_string(), "linux".to_string()]);
        assert_eq!(deduce_platforms(&mixed), plats);
    }
}
