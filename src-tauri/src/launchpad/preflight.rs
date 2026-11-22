//! 广场投稿只读预检：坐标解析、重复性、OSI 协议、Release 产物与图标可用性。

use super::{
    canonical_id, sanitize_icon, LaunchpadPreflightResult, PreflightCheckItem, PreflightCheckKey,
    PreflightCheckStatus,
};
use crate::AppState;

/// 解析投稿输入坐标（支持 `owner/repo`、`@owner/repo`、短前缀或完整 Forge URL）。
pub fn parse_preflight_coord(repo_url: &str) -> Option<(crate::forge::UniversalRepoCoord, String)> {
    let trimmed = repo_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized =
        if trimmed.starts_with('@') && !trimmed.contains("://") && !trimmed.contains(':') {
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
        format!("无法识别仓库地址：{trimmed}（支持 GitHub / Codeberg / Gitea / GitLab 公开仓库）")
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
                format!(
                    "https://github.com/{}.png",
                    urlencoding::encode(&coord.owner)
                )
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

/// D8 首包验图通过则采用自定义 https 图标；否则（或未提供）自动探测仓库图标。
pub(crate) async fn resolve_preflight_icon(
    icon_client: &reqwest::Client,
    api_client: &reqwest::Client,
    coord: &crate::forge::UniversalRepoCoord,
    github_token: Option<&str>,
    custom_icon_url: Option<&str>,
) -> PreflightIconOutcome {
    let auto_probe = || async {
        if coord.forge == crate::forge::ForgeType::GitHub {
            let slow_headers = github_token.filter(|t| !t.trim().is_empty()).map(|t| {
                crate::forge::http::preset_headers(
                    crate::forge::http::ApiPreset::GithubApi,
                    Some(t),
                    crate::forge::http::AuthScheme::Bearer,
                )
            });
            crate::icons::probe_single_live(
                icon_client,
                api_client,
                slow_headers.as_ref(),
                &coord.owner,
                &coord.repo,
            )
            .await
            .map(|(url, _)| url)
        } else {
            crate::icons::probe_l2_simple(icon_client, &coord.owner, &coord.repo).await
        }
    };

    let custom_raw = custom_icon_url.map(str::trim).unwrap_or("");
    if custom_raw.is_empty() {
        return PreflightIconOutcome::AutoProbed(auto_probe().await);
    }
    let clean_https = sanitize_icon(custom_raw);
    if clean_https.is_empty() || custom_raw.chars().any(char::is_whitespace) {
        return PreflightIconOutcome::CustomInvalidScheme(
            "自定义图标直链仅支持无空白的 https:// 链接（拒绝 http:// 与 data:）".to_string(),
        );
    }
    if crate::icons::verify_custom_icon_d8(icon_client, &clean_https).await {
        PreflightIconOutcome::CustomValid(clean_https)
    } else {
        PreflightIconOutcome::CustomUnreachableFallback(auto_probe().await)
    }
}

/// 应用内投稿预检（只读）：并发探测仓库、最新 Release 与图标后汇总为预检结果。
pub(crate) async fn preflight_submission(
    state: &AppState,
    repo_url: &str,
    custom_icon_url: Option<&str>,
) -> Result<LaunchpadPreflightResult, String> {
    let Some((coord, canonical_id)) = parse_preflight_coord(repo_url) else {
        return Ok(invalid_coord_preflight_result(repo_url));
    };

    let cfg = crate::config::get_project_config();
    let source_url = cfg.launchpad.default_source_url.trim().to_string();
    let already_in_catalog = state.catalog.is_cataloged(&canonical_id);
    let github_token = state.active_github_token();
    let (already_in_launchpad, host_token) = {
        let db = state.db()?;
        let in_lp = super::feed::is_id_in_snapshot(&db, &source_url, &canonical_id);
        let tok = if coord.forge == crate::forge::ForgeType::GitHub {
            github_token.clone()
        } else {
            db.get_host_token(&coord.host)
                .ok()
                .flatten()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        (in_lp, tok)
    };

    let timeout_secs = cfg.network.api_timeout_seconds;
    let icon_client = crate::forge::http::new_icon_client(timeout_secs)?;
    let api_client = crate::forge::http::new_api_client(timeout_secs)?;

    let token_ref = host_token.as_deref();
    let (repo_res, release_res, icon_outcome) = tokio::join!(
        crate::forge::ForgeRegistry::fetch_repo(&coord, token_ref),
        crate::forge::ForgeRegistry::fetch_latest_release(&coord, token_ref),
        resolve_preflight_icon(
            &icon_client,
            &api_client,
            &coord,
            github_token.as_deref(),
            custom_icon_url,
        ),
    );

    if let Ok(ref repo_info) = repo_res {
        if coord.forge == crate::forge::ForgeType::GitHub {
            crate::icons::remember_repo_default_branch(
                &coord.owner,
                &coord.repo,
                &repo_info.default_branch,
            );
        }
    }

    Ok(evaluate_launchpad_preflight(LaunchpadPreflightInput {
        coord: &coord,
        canonical_id: &canonical_id,
        already_in_launchpad,
        already_in_catalog,
        repo_res: repo_res.as_ref().map_err(String::as_str),
        release_res: release_res.as_ref().map_err(String::as_str),
        icon_outcome,
        allowed_licenses: &cfg.license_gate.allowed,
    }))
}
