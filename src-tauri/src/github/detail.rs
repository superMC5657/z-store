use super::models::{GitHubAssetResponse, GitHubReleaseResponse, GitHubRepoResponse};
use super::CatalogService;
use crate::installer::InstallerEngine;
use crate::models::{AppDetail, ReleaseAsset};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, IF_NONE_MATCH, USER_AGENT};
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

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github.v3+json"),
        );

        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        if let Some(ref etag) = cached_etag {
            if let Ok(val) = HeaderValue::from_str(etag) {
                headers.insert(IF_NONE_MATCH, val);
            }
        }

        let api_timeout = std::time::Duration::from_secs(
            crate::config::get_project_config().network.api_timeout_seconds,
        );
        let release_url = format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            owner, repo
        );
        let req_id = crate::z_log::new_req_id();
        let sid = crate::z_log::new_session_id();
        let release_host = crate::log_support::host_of(&release_url);
        let safe_release = crate::log_support::sanitize_url(&release_url);
        log::debug!("http get release id={} sid={} req={} url='{}'", id, sid, req_id, safe_release);
        let start_rel = std::time::Instant::now();
        let req = client.get(&release_url).headers(headers.clone()).send();
        let resp = match tokio::time::timeout(api_timeout, req).await {
            Ok(r) => r.ok(),
            Err(_) => None,
        };
        let rel_elapsed = start_rel.elapsed().as_millis();
        let rel_status = resp.as_ref().map(|r| r.status().as_u16()).unwrap_or(0);
        log::debug!("http resp release id={} sid={} req={} url='{}' status={} elapsed_ms={}", id, sid, req_id, safe_release, rel_status, rel_elapsed);
        log::info!("http resp release id={} sid={} req={} host={} status={} elapsed_ms={}", id, sid, req_id, release_host, rel_status, rel_elapsed);

        let is_auth_unauthorized = resp.as_ref().map(|r| r.status() == reqwest::StatusCode::UNAUTHORIZED).unwrap_or(false);
        if is_auth_unauthorized {
            crate::notify_auth_expired();
        }

        if let Some(ref res) = resp {
            crate::notify_rate_limit("github.com", res.headers());
        }

        // 核心提速门禁：若 GitHub 返回 304 Not Modified（说明最新 Release 版本完全未变）
        // 且本地已有完整缓存详情，直接零网络开销复用已有 README 与 Release 资产，实现 ~50ms 闪电响应
        if let Some(ref res) = resp {
            if res.status() == reqwest::StatusCode::NOT_MODIFIED {
                if let Some(ref existing) = cached_detail {
                    if !existing.releases.is_empty() && !existing.readme_markdown.trim().is_empty()
                    {
                        let mut detail = existing.clone();
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as i64;
                        detail.cached_at = Some(now);
                        detail.is_stale_fallback = None;
                        return Ok((detail, None));
                    }
                }
            }
        }

        let (release_resp, new_cache) = match resp {
            Some(res) if res.status() == reqwest::StatusCode::NOT_MODIFIED => {
                // 304 Not Modified 但本地缺乏完整 cached_detail 时回退走 payload_json 恢复
                if let Some(ref payload) = cached_payload {
                    let parsed: GitHubReleaseResponse = serde_json::from_str(payload)
                        .map_err(|e| format!("解析本地 ETag 缓存失败: {}", e))?;
                    (parsed, None)
                } else {
                    return Err("304 响应但本地未找到缓存数据".to_string());
                }
            }
            Some(res) if res.status().is_success() => {
                let new_etag = res
                    .headers()
                    .get("etag")
                    .and_then(|h| h.to_str().ok())
                    .map(|s| s.to_string());

                let payload_text = res.text().await.map_err(|e| e.to_string())?;
                let parsed: GitHubReleaseResponse = serde_json::from_str(&payload_text)
                    .map_err(|e| format!("解析 GitHub Release 失败: {}", e))?;

                let cache_tuple = new_etag.map(|et| (et, payload_text));
                (parsed, cache_tuple)
            }
            _ => {
                // 离线或网络异常回退：若有 cached_detail 直接使用
                if let Some(mut existing) = cached_detail {
                    existing.is_stale_fallback = Some(true);
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

        // 异步并发执行：提取校验和字典、获取 README Markdown、以及拉取实时仓库状态 (Stars/Forks/License)
        let checksum_task =
            Self::extract_checksums_map(&release_resp.assets, client, &headers, id, &sid, &req_id);

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
            log::debug!("http get readme id={} sid={} req={} url='{}'", readme_id, readme_sid, readme_req, crate::log_support::sanitize_url(&readme_url));
            let start_readme = std::time::Instant::now();
            let req = client.get(&readme_url).headers(readme_headers).send();
            match tokio::time::timeout(api_timeout, req).await {
                Ok(Ok(res)) => {
                    crate::notify_rate_limit("github.com", res.headers());
                    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
                        crate::notify_auth_expired();
                    }
                    let status = res.status().as_u16();
                    log::debug!("http resp readme id={} sid={} req={} url='{}' status={} elapsed_ms={}", readme_id, readme_sid, readme_req, crate::log_support::sanitize_url(&readme_url), status, start_readme.elapsed().as_millis());
                    log::info!("http resp readme id={} sid={} req={} host={} status={} elapsed_ms={}", readme_id, readme_sid, readme_req, crate::log_support::host_of(&readme_url), status, start_readme.elapsed().as_millis());
                    if res.status().is_success() {
                        res.text().await.unwrap_or(default_readme_clone)
                    } else {
                        default_readme_clone
                    }
                }
                _ => {
                    log::warn!("http resp readme failed id={} sid={} req={} host={} elapsed_ms={}", readme_id, readme_sid, readme_req, crate::log_support::host_of(&readme_url), start_readme.elapsed().as_millis());
                    default_readme_clone
                }
            }
        };

        let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let mut repo_headers = headers.clone();
        repo_headers.remove(IF_NONE_MATCH);
        // 显式克隆 sid/req/id 供 async 块内日志使用（不碰 thread-local，不改并发）。
        let repo_id = id.to_string();
        let repo_sid = sid.clone();
        let repo_req = req_id.clone();
        let repo_task = async {
            log::debug!("http get repo id={} sid={} req={} url='{}'", repo_id, repo_sid, repo_req, crate::log_support::sanitize_url(&repo_url));
            let start_repo = std::time::Instant::now();
            let req = client.get(&repo_url).headers(repo_headers).send();
            match tokio::time::timeout(api_timeout, req).await {
                Ok(Ok(res)) => {
                    crate::notify_rate_limit("github.com", res.headers());
                    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
                        crate::notify_auth_expired();
                    }
                    let status = res.status().as_u16();
                    log::debug!("http resp repo id={} sid={} req={} url='{}' status={} elapsed_ms={}", repo_id, repo_sid, repo_req, crate::log_support::sanitize_url(&repo_url), status, start_repo.elapsed().as_millis());
                    log::info!("http resp repo id={} sid={} req={} host={} status={} elapsed_ms={}", repo_id, repo_sid, repo_req, crate::log_support::host_of(&repo_url), status, start_repo.elapsed().as_millis());
                    if res.status().is_success() {
                        res.json::<GitHubRepoResponse>().await.ok()
                    } else {
                        None
                    }
                }
                _ => {
                    log::warn!("http resp repo failed id={} sid={} req={} host={} elapsed_ms={}", repo_id, repo_sid, repo_req, crate::log_support::host_of(&repo_url), start_repo.elapsed().as_millis());
                    None
                }
            }
        };

        let (checksums, raw_readme, repo_info) =
            tokio::join!(checksum_task, readme_task, repo_task);

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

        let mut releases = Vec::new();
        for asset in release_resp.assets {
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
                crate::installer::AssetKind::Other => "other",
            };

            let matched_sha256 = checksums.get(&asset.name).cloned();

            releases.push(ReleaseAsset {
                name: asset.name,
                download_url: asset.browser_download_url,
                size_bytes: asset.size,
                sha256: matched_sha256,
                os: os.to_string(),
                arch: arch.to_string(),
                kind: kind_str.to_string(),
            });
        }

        // 按当前宿主系统和 CPU 架构智能打分降序排列，最优资产置于 index 0
        releases.sort_by_key(|b| std::cmp::Reverse(crate::installer::score_asset(b)));

        // 图标层级决策：
        // 1. 若当前应用已具备已知独立官方图标（如收录库指定或 https:// 开头头像），优先保持该正方形应用图标，避免被 README 宽幅 Banner 误覆盖；
        // 2. 若当前未收录，则优先采用从 README 中提取并已清洗出的 Logo；
        // 3. 兜底采用 GitHub 官方组织头像 https://github.com/{owner}.png
        let final_icon = if icon.starts_with("http://") || icon.starts_with("https://") {
            icon
        } else if let Some(logo) = extracted_logo {
            logo
        } else {
            format!("https://github.com/{}.png", owner)
        };

        let detail = AppDetail {
            id: id.to_string(),
            name,
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
            is_verified: catalog_item.as_ref().map(|i| i.is_verified).unwrap_or(false),
            signature_fingerprint: catalog_item
                .as_ref()
                .and_then(|i| i.publisher_fingerprint.clone()),
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
            cached_at: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
            ),
            is_stale_fallback: None,
            homepage: latest_homepage,
            platforms: catalog_item
                .as_ref()
                .map(|i| i.platforms.clone())
                .unwrap_or_else(|| vec!["windows".to_string()]),
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
        let checksum_asset = assets.iter().find(|a| {
            let n = a.name.to_lowercase();
            n.contains("checksum") || n.contains("sha256") || n.ends_with(".sha256")
        });

        let Some(asset) = checksum_asset else {
            log::debug!(
                "checksum skip id={} sid={} req={} reason=no_checksum_asset assets={} elapsed_ms={}",
                app_id,
                sid,
                req_id,
                assets.len(),
                start.elapsed().as_millis()
            );
            return map;
        };
        // 仅记文件名 + 字节数 + 脱敏 URL/host，永不记 body/hash 值。
        let file_name = asset.name.clone();
        let file_bytes = asset.size;
        let safe_url = crate::log_support::sanitize_url(&asset.browser_download_url);
        let host = crate::log_support::host_of(&asset.browser_download_url);
        log::debug!(
            "checksum fetch start id={} sid={} req={} file='{}' bytes={} url='{}'",
            app_id,
            sid,
            req_id,
            file_name,
            file_bytes,
            safe_url
        );
        let api_timeout = std::time::Duration::from_secs(
            crate::config::get_project_config().network.api_timeout_seconds,
        );
        let req = client
            .get(&asset.browser_download_url)
            .headers(headers.clone())
            .send();
        let fetch_res = tokio::time::timeout(api_timeout, req).await;
        let Ok(Ok(res)) = fetch_res else {
            let reason = match fetch_res {
                Ok(Err(e)) => crate::log_support::short_reason(&e.to_string()),
                _ => "timeout_or_send_failed".to_string(),
            };
            log::debug!(
                "checksum fail id={} sid={} req={} file='{}' host={} reason={} elapsed_ms={}",
                app_id,
                sid,
                req_id,
                file_name,
                host,
                reason,
                start.elapsed().as_millis()
            );
            return map;
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
        let Ok(text) = res.text().await else {
            log::debug!(
                "checksum fail id={} sid={} req={} file='{}' host={} reason=read_body_failed elapsed_ms={}",
                app_id,
                sid,
                req_id,
                file_name,
                host,
                start.elapsed().as_millis()
            );
            return map;
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
