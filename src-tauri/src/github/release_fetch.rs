//! Release 拉取纯决议：封装 `releases/latest` ETag GET 的 shallow（流式更新检查 / platforms-lite）
//! 与 deep（详情页）决议逻辑及统一的缓存副作用落库口。

use super::models::{GitHubAssetResponse, GitHubReleaseResponse};
use crate::github::http::EtagGetOutcome;
use crate::models::AppDetail;

fn parse_release_payload(text: &str) -> Result<GitHubReleaseResponse, serde_json::Error> {
    serde_json::from_str::<GitHubReleaseResponse>(text)
}

/// shallow 决议投影来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShallowSource {
    Fresh,
    Payload,
    StaleRow,
    Catalog,
}

/// shallow 决议输出：轻量 tag、body 与 assets 投影。
#[derive(Debug)]
pub(crate) struct ShallowRelease {
    pub tag: String,
    pub body: String,
    pub assets: Vec<GitHubAssetResponse>,
    pub source: ShallowSource,
    /// 304 命中恢复时为 true，调用方刷新详情 `cached_at`；stale 穿透为 false。
    pub touch: bool,
    pub cache_to_save: Option<(String, String)>,
    pub row_platforms: Option<Vec<String>>,
    pub stale: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShallowMiss {
    NotModifiedWithoutCache,
    OfflineWithoutCache,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ShallowError {
    Parse(String),
    PayloadCorrupt(String),
    Miss(ShallowMiss),
}

fn row_release(row: &AppDetail, touch: bool, stale: Option<bool>) -> ShallowRelease {
    ShallowRelease {
        tag: row.core.latest_version.clone(),
        body: row.changelog.clone(),
        assets: Vec::new(),
        source: ShallowSource::StaleRow,
        touch,
        cache_to_save: None,
        row_platforms: Some(row.core.platforms.clone()),
        stale,
    }
}

/// 轻量 release 决议（供流式更新检查与 `get_platforms_lite` 共用）。
pub(crate) fn decide_shallow_release(
    outcome: &EtagGetOutcome,
    cached_payload: Option<&str>,
    stale_row: Option<&AppDetail>,
    catalog_default_version: Option<&str>,
) -> Result<ShallowRelease, ShallowError> {
    match outcome {
        EtagGetOutcome::Fresh { text, etag } => {
            let parsed = parse_release_payload(text)
                .map_err(|e| ShallowError::Parse(format!("解析 GitHub Release 失败: {e}")))?;
            Ok(ShallowRelease {
                tag: parsed.tag_name,
                body: parsed.body.unwrap_or_default(),
                assets: parsed.assets,
                source: ShallowSource::Fresh,
                touch: false,
                cache_to_save: etag.clone().map(|et| (et, text.clone())),
                row_platforms: None,
                stale: None,
            })
        }
        EtagGetOutcome::NotModified => {
            if let Some(payload) = cached_payload {
                match parse_release_payload(payload) {
                    Ok(parsed) => {
                        return Ok(ShallowRelease {
                            tag: parsed.tag_name,
                            body: parsed.body.unwrap_or_default(),
                            assets: parsed.assets,
                            source: ShallowSource::Payload,
                            touch: true,
                            cache_to_save: None,
                            row_platforms: None,
                            stale: None,
                        });
                    }
                    Err(e) => {
                        return Err(ShallowError::PayloadCorrupt(format!(
                            "解析本地 ETag 缓存失败: {e}"
                        )));
                    }
                }
            }
            if let Some(row) = stale_row {
                return Ok(row_release(row, true, row.is_stale));
            }
            if let Some(ver) = catalog_default_version {
                return Ok(ShallowRelease {
                    tag: ver.to_string(),
                    body: String::new(),
                    assets: Vec::new(),
                    source: ShallowSource::Catalog,
                    touch: true,
                    cache_to_save: None,
                    row_platforms: None,
                    stale: None,
                });
            }
            Err(ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache))
        }
        EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed => {
            if let Some(payload) = cached_payload {
                if let Ok(parsed) = parse_release_payload(payload) {
                    return Ok(ShallowRelease {
                        tag: parsed.tag_name,
                        body: parsed.body.unwrap_or_default(),
                        assets: parsed.assets,
                        source: ShallowSource::Payload,
                        touch: false,
                        cache_to_save: None,
                        row_platforms: None,
                        stale: None,
                    });
                }
            }
            if let Some(row) = stale_row {
                return Ok(row_release(row, false, Some(true)));
            }
            if let Some(ver) = catalog_default_version {
                return Ok(ShallowRelease {
                    tag: ver.to_string(),
                    body: String::new(),
                    assets: Vec::new(),
                    source: ShallowSource::Catalog,
                    touch: false,
                    cache_to_save: None,
                    row_platforms: None,
                    stale: None,
                });
            }
            Err(ShallowError::Miss(ShallowMiss::OfflineWithoutCache))
        }
    }
}

// ---------------------------------------------------------------------------
// deep adapter：`fetch_app_detail` 详情路径（repo + README + Checksum Manifest + 平台推导的上游）
// ---------------------------------------------------------------------------

/// deep adapter 输入（均为借用；`cached_detail` 仅 ReuseStale 时 clone）。
pub(crate) struct DetailReleaseInput<'a> {
    pub outcome: &'a EtagGetOutcome,
    pub cached_payload: Option<&'a str>,
    pub cached_detail: Option<&'a AppDetail>,
    pub catalog_default_version: Option<&'a str>,
    /// 收录库人工精校简介（无收录项或无字段时为 None；`is_some` 门控）。
    pub catalog_description_en: Option<&'a str>,
    /// repo 并发请求是否成功（`repo_info.is_some()`）：决定失败时走 fresh 空行还是 stale 合成空。
    pub repo_ok: bool,
    pub is_auth_unauthorized: bool,
}

/// deep adapter 决议。
#[derive(Debug)]
pub(crate) enum DetailReleaseDecision {
    /// 继续详情组装：release + 待落库 ETag 元组 + 是否合成空失败（stale 标记用）。
    Proceed {
        release: GitHubReleaseResponse,
        cache_to_save: Option<(String, String)>,
        synthesized_empty_failure: bool,
    },
    /// 瞬时失败且有旧详情行：调用方直接返回该行（stale 穿透，不 touch 不落库）。
    /// Box 装箱：AppDetail 远大于 Proceed 臂，避免枚举整体膨胀（clippy::large_enum_variant）。
    ReuseStale(Box<AppDetail>),
}

/// deep adapter 入口（纯函数，供 `fetch_app_detail` 的 release 段）。
/// repo/README/Checksum Manifest（校验清单）/平台推导仍由调用方继续。
pub(crate) fn decide_detail_release(
    input: DetailReleaseInput<'_>,
) -> Result<DetailReleaseDecision, String> {
    match input.outcome {
        EtagGetOutcome::NotModified => {
            if let Some(payload) = input.cached_payload {
                let parsed = parse_release_payload(payload)
                    .map_err(|e| format!("解析本地 ETag 缓存失败: {e}"))?;
                Ok(DetailReleaseDecision::Proceed {
                    release: parsed,
                    cache_to_save: None,
                    synthesized_empty_failure: false,
                })
            } else {
                Err("304 响应但本地未找到缓存数据".to_string())
            }
        }
        EtagGetOutcome::Fresh { text, etag } => {
            let parsed = parse_release_payload(text)
                .map_err(|e| format!("解析 GitHub Release 失败: {e}"))?;
            Ok(DetailReleaseDecision::Proceed {
                release: parsed,
                cache_to_save: etag.clone().map(|et| (et, text.clone())),
                synthesized_empty_failure: false,
            })
        }
        EtagGetOutcome::Unauthorized | EtagGetOutcome::Failed => {
            // 离线或网络异常回退：若有 cached_detail 直接使用（stale 穿透）。
            if let Some(existing) = input.cached_detail {
                let mut reused = existing.clone();
                if let Some(desc_en) = input.catalog_description_en {
                    reused.core.description_en = Some(desc_en.to_string());
                }
                reused.is_stale = Some(true);
                return Ok(DetailReleaseDecision::ReuseStale(Box::new(reused)));
            }
            if let Some(payload) = input.cached_payload {
                let parsed =
                    parse_release_payload(payload).map_err(|e| format!("解析离线缓存失败: {e}"))?;
                return Ok(DetailReleaseDecision::Proceed {
                    release: parsed,
                    cache_to_save: None,
                    synthesized_empty_failure: false,
                });
            }
            let fallback_ver = input
                .catalog_default_version
                .unwrap_or("v1.0.0")
                .to_string();
            if input.repo_ok {
                // repo 已 200 即证明在线/仓库存在：releases/latest 单点 Failed
                //（404 无 Release /403/限流/无 token）不视为离线，以 fresh 空行返回。
                return Ok(DetailReleaseDecision::Proceed {
                    release: GitHubReleaseResponse {
                        tag_name: fallback_ver,
                        body: Some(String::new()),
                        assets: Vec::new(),
                    },
                    cache_to_save: None,
                    synthesized_empty_failure: false,
                });
            }
            // 无任何本地缓存 + repo 亦失败/401/离线时的合成空详情（is_stale=true 区分于成功空）。
            let fallback_body = if input.is_auth_unauthorized {
                "GitHub 登录凭据已失效 (401)，暂无法同步最新 Release 发布产物。请重新登录授权。"
                    .to_string()
            } else {
                "离线模式，暂无法直连获取 GitHub Release 变更日志。".to_string()
            };
            Ok(DetailReleaseDecision::Proceed {
                release: GitHubReleaseResponse {
                    tag_name: fallback_ver,
                    body: Some(fallback_body),
                    assets: Vec::new(),
                },
                cache_to_save: None,
                synthesized_empty_failure: true,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// release touch/save/stale 效应收敛（shallow + deep 调用点同一 interface）
// ---------------------------------------------------------------------------

/// 执行 release 请求后的缓存副作用：`touch` 时刷新详情 `cached_at`，有 ETag 时落库条件请求缓存。
pub(crate) fn apply_release_cache_effects(
    db: &crate::db::Database,
    release_endpoint: &str,
    app_id: &str,
    touch: bool,
    cache_to_save: Option<(String, String)>,
    now_secs: i64,
) {
    if touch {
        let _ = db.touch_app_detail(app_id, now_secs);
    }
    if let Some((etag, payload)) = cache_to_save {
        let _ = db.save_etag(release_endpoint, &etag, &payload, now_secs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppCore;

    fn release_json(tag: &str, body: &str) -> String {
        serde_json::json!({
            "tag_name": tag,
            "body": body,
            "assets": [
                {
                    "name": "app-setup.exe",
                    "size": 20_000_000,
                    "browser_download_url": "https://example.com/app-setup.exe"
                }
            ]
        })
        .to_string()
    }

    fn sample_row() -> AppDetail {
        AppDetail {
            core: AppCore {
                id: "o/r".to_string(),
                name: "r".to_string(),
                description_en: Some("EN".to_string()),
                owner: "o".to_string(),
                repo: "r".to_string(),
                icon: String::new(),
                icon_bg: String::new(),
                description: "desc".to_string(),
                stars: 1,
                forks: 0,
                license: "MIT".to_string(),
                latest_version: "v1.0.0".to_string(),
                is_verified: false,
                category: "dev".to_string(),
                category_name: "开发工具".to_string(),
                forge: Some("github".to_string()),
                forge_host: Some("github.com".to_string()),
                homepage: None,
                platforms: vec!["windows".to_string()],
                is_cataloged: None,
                source: None,
                status: None,
                added_at: None,
                alternatives: Vec::new(),
            },
            changelog: "old notes".to_string(),
            readme_markdown: "# r".to_string(),
            readme_variants: None,
            releases: vec![],
            cached_at: None,
            is_stale: None,
        }
    }

    // ---- shallow：Fresh ----

    #[test]
    fn shallow_fresh_resolves_tag_body_and_save_intent() {
        let outcome = EtagGetOutcome::Fresh {
            text: release_json("v2.0.0", "notes"),
            etag: Some("W/\"abc\"".to_string()),
        };
        let rel = decide_shallow_release(&outcome, None, None, None).unwrap();
        assert_eq!(rel.tag, "v2.0.0");
        assert_eq!(rel.body, "notes");
        assert_eq!(rel.assets.len(), 1);
        assert_eq!(rel.source, ShallowSource::Fresh);
        assert!(!rel.touch);
        assert!(rel.row_platforms.is_none());
        assert!(rel.stale.is_none());
        let (et, txt) = rel.cache_to_save.expect("fresh with etag must save");
        assert_eq!(et, "W/\"abc\"");
        assert!(txt.contains("v2.0.0"));
    }

    #[test]
    fn shallow_fresh_without_etag_has_no_save() {
        let outcome = EtagGetOutcome::Fresh {
            text: release_json("v2.0.0", "notes"),
            etag: None,
        };
        let rel = decide_shallow_release(&outcome, None, None, None).unwrap();
        assert!(rel.cache_to_save.is_none());
        assert!(!rel.touch);
    }

    #[test]
    fn shallow_fresh_parse_error_reports_parse() {
        let outcome = EtagGetOutcome::Fresh {
            text: "not-json".to_string(),
            etag: None,
        };
        let err = decide_shallow_release(&outcome, None, None, None).unwrap_err();
        match err {
            ShallowError::Parse(msg) => assert!(msg.starts_with("解析 GitHub Release 失败")),
            other => panic!("unexpected {other:?}"),
        }
    }

    // ---- shallow：304（ETag Cache 条件请求缓存 touch/save/回退同一 interface） ----

    #[test]
    fn shallow_not_modified_restores_payload_and_touches() {
        let outcome = EtagGetOutcome::NotModified;
        let payload = release_json("v1.5.0", "cached notes");
        let row = sample_row();
        // payload 优先于旧行（fresher-first）。
        let rel =
            decide_shallow_release(&outcome, Some(&payload), Some(&row), Some("v9.9.9")).unwrap();
        assert_eq!(rel.tag, "v1.5.0");
        assert_eq!(rel.body, "cached notes");
        assert_eq!(rel.source, ShallowSource::Payload);
        assert!(rel.touch);
        assert!(rel.cache_to_save.is_none());
        assert!(rel.stale.is_none());
    }

    #[test]
    fn shallow_not_modified_corrupt_payload_is_terminal_for_lite() {
        // 304 payload 腐坏为终端错：lite-304 映射硬错"解析本地 ETag 缓存失败"，
        // 更新检查以 payload=None 重试（tolerant），见调用方注释。
        let outcome = EtagGetOutcome::NotModified;
        let row = sample_row();
        let err = decide_shallow_release(&outcome, Some("corrupt"), Some(&row), Some("v9.9.9"))
            .unwrap_err();
        match err {
            ShallowError::PayloadCorrupt(msg) => {
                assert!(msg.starts_with("解析本地 ETag 缓存失败"))
            }
            other => panic!("unexpected {other:?}"),
        }
        // 更新检查 tolerant 重试形状：去 payload 后沿行回退。
        let rel = decide_shallow_release(&outcome, None, Some(&row), Some("v9.9.9")).unwrap();
        assert_eq!(rel.source, ShallowSource::StaleRow);
        assert!(rel.touch);
        assert_eq!(rel.tag, "v1.0.0");
    }

    #[test]
    fn shallow_not_modified_row_and_catalog_chain() {
        let outcome = EtagGetOutcome::NotModified;
        let mut row = sample_row();
        row.is_stale = Some(true);
        // 行回退：回显已 deduce platforms 与旧行 stale（lite-304 现行语义）。
        let rel = decide_shallow_release(&outcome, None, Some(&row), Some("v9.9.9")).unwrap();
        assert_eq!(rel.source, ShallowSource::StaleRow);
        assert!(rel.touch);
        assert_eq!(rel.row_platforms, Some(vec!["windows".to_string()]));
        assert_eq!(rel.stale, Some(true));
        // 收录库回退。
        let rel = decide_shallow_release(&outcome, None, None, Some("v9.9.9")).unwrap();
        assert_eq!(rel.source, ShallowSource::Catalog);
        assert_eq!(rel.tag, "v9.9.9");
        assert_eq!(rel.body, "");
        assert!(rel.touch);
        // 全空。
        let err = decide_shallow_release(&outcome, None, None, None).unwrap_err();
        assert_eq!(
            err,
            ShallowError::Miss(ShallowMiss::NotModifiedWithoutCache)
        );
    }

    // ---- shallow：失败穿透 ----

    #[test]
    fn shallow_failed_prefers_payload_then_row_then_catalog() {
        let payload = release_json("v1.5.0", "cached notes");
        let row = sample_row();
        for outcome in [EtagGetOutcome::Failed, EtagGetOutcome::Unauthorized] {
            // payload 优先（fresher-first；lite-离线归一化，见模块注释）。
            let rel = decide_shallow_release(&outcome, Some(&payload), Some(&row), Some("v9.9.9"))
                .unwrap();
            assert_eq!(rel.source, ShallowSource::Payload);
            assert!(!rel.touch);
            assert!(rel.cache_to_save.is_none());
            assert!(rel.stale.is_none());
            // 行穿透：失败时 stale 恒 Some(true)，永不 touch。
            let rel = decide_shallow_release(&outcome, None, Some(&row), Some("v9.9.9")).unwrap();
            assert_eq!(rel.source, ShallowSource::StaleRow);
            assert!(!rel.touch);
            assert_eq!(rel.stale, Some(true));
            assert_eq!(rel.row_platforms, Some(vec!["windows".to_string()]));
            // 收录库。
            let rel = decide_shallow_release(&outcome, None, None, Some("v9.9.9")).unwrap();
            assert_eq!(rel.source, ShallowSource::Catalog);
            assert_eq!(rel.tag, "v9.9.9");
            // 全空。
            let err = decide_shallow_release(&outcome, None, None, None).unwrap_err();
            assert_eq!(err, ShallowError::Miss(ShallowMiss::OfflineWithoutCache));
        }
    }

    #[test]
    fn shallow_failed_corrupt_payload_is_tolerant() {
        // 失败路径 tolerant：payload 腐坏直接跳过（lite-离线 `if let Ok` 现行语义）。
        let outcome = EtagGetOutcome::Failed;
        let row = sample_row();
        let rel = decide_shallow_release(&outcome, Some("corrupt"), Some(&row), None).unwrap();
        assert_eq!(rel.source, ShallowSource::StaleRow);
        let err = decide_shallow_release(&outcome, Some("corrupt"), None, None).unwrap_err();
        assert_eq!(err, ShallowError::Miss(ShallowMiss::OfflineWithoutCache));
    }

    // ---- deep ----

    #[test]
    fn apply_release_cache_effects_saves_etag_and_touches_without_error() {
        // touch/save 双效应单口执行（无行 touch 为空操作不炸；save 落库 ETag 键）。
        let db = crate::db::Database::open_in_memory().unwrap();
        let ep = "https://api.github.com/repos/o/r/releases/latest";
        super::apply_release_cache_effects(
            &db,
            ep,
            "o/r",
            true,
            Some(("W/\"e\"".to_string(), "{\"tag_name\":\"v1\"}".to_string())),
            1700000000,
        );
        assert_eq!(db.get_etag(ep).unwrap().as_deref(), Some("W/\"e\""));
        assert_eq!(
            db.get_cached_payload(ep).unwrap().as_deref(),
            Some("{\"tag_name\":\"v1\"}")
        );
        // 全空调用同样不炸（stale 穿透 touch=false + 无落库形状）。
        super::apply_release_cache_effects(&db, ep, "o/r", false, None, 1700000000);
        assert_eq!(db.get_etag(ep).unwrap().as_deref(), Some("W/\"e\""));
    }

    #[test]
    fn deep_not_modified_restores_payload_or_errors() {
        let payload = release_json("v1.5.0", "cached notes");
        let input = DetailReleaseInput {
            outcome: &EtagGetOutcome::NotModified,
            cached_payload: Some(&payload),
            cached_detail: None,
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        match decide_detail_release(input).unwrap() {
            DetailReleaseDecision::Proceed {
                release,
                cache_to_save,
                synthesized_empty_failure,
            } => {
                assert_eq!(release.tag_name, "v1.5.0");
                assert!(cache_to_save.is_none());
                assert!(!synthesized_empty_failure);
            }
            other => panic!("unexpected {other:?}"),
        }
        let input = DetailReleaseInput {
            outcome: &EtagGetOutcome::NotModified,
            cached_payload: None,
            cached_detail: None,
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        assert_eq!(
            decide_detail_release(input).unwrap_err(),
            "304 响应但本地未找到缓存数据"
        );
    }

    #[test]
    fn deep_fresh_parses_and_returns_save_tuple() {
        let outcome = EtagGetOutcome::Fresh {
            text: release_json("v3.0.0", "big notes"),
            etag: Some("W/\"z\"".to_string()),
        };
        let input = DetailReleaseInput {
            outcome: &outcome,
            cached_payload: None,
            cached_detail: None,
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        match decide_detail_release(input).unwrap() {
            DetailReleaseDecision::Proceed {
                release,
                cache_to_save,
                synthesized_empty_failure,
            } => {
                assert_eq!(release.tag_name, "v3.0.0");
                assert_eq!(release.assets.len(), 1);
                assert!(cache_to_save.is_some());
                assert!(!synthesized_empty_failure);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn deep_failed_reuses_stale_row_with_desc_patch() {
        let mut row = sample_row();
        row.is_stale = None;
        let input = DetailReleaseInput {
            outcome: &EtagGetOutcome::Failed,
            cached_payload: None,
            cached_detail: Some(&row),
            catalog_default_version: None,
            catalog_description_en: Some("Curated EN"),
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        match decide_detail_release(input).unwrap() {
            DetailReleaseDecision::ReuseStale(reused) => {
                assert_eq!(reused.core.latest_version, "v1.0.0");
                assert_eq!(reused.core.description_en.as_deref(), Some("Curated EN"));
                assert_eq!(reused.is_stale, Some(true));
            }
            other => panic!("unexpected {other:?}"),
        }
        // 无收录简介时不覆盖旧行。
        let input = DetailReleaseInput {
            outcome: &EtagGetOutcome::Unauthorized,
            cached_payload: None,
            cached_detail: Some(&row),
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: true,
        };
        match decide_detail_release(input).unwrap() {
            DetailReleaseDecision::ReuseStale(reused) => {
                assert_eq!(reused.core.description_en.as_deref(), Some("EN"));
                assert_eq!(reused.is_stale, Some(true));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn deep_failed_payload_repo_empty_and_synth_shapes() {
        let payload = release_json("v1.5.0", "cached notes");
        // payload 恢复（offline 解析错文案独立）。
        let input = DetailReleaseInput {
            outcome: &EtagGetOutcome::Failed,
            cached_payload: Some(&payload),
            cached_detail: None,
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        match decide_detail_release(input).unwrap() {
            DetailReleaseDecision::Proceed { release, .. } => {
                assert_eq!(release.tag_name, "v1.5.0")
            }
            other => panic!("unexpected {other:?}"),
        }
        let bad = DetailReleaseInput {
            outcome: &EtagGetOutcome::Failed,
            cached_payload: Some("corrupt"),
            cached_detail: None,
            catalog_default_version: None,
            catalog_description_en: None,
            repo_ok: false,
            is_auth_unauthorized: false,
        };
        assert!(decide_detail_release(bad)
            .unwrap_err()
            .starts_with("解析离线缓存失败"));
        // repo 存活 → fresh 空行（非 stale）。
        let empty = DetailReleaseInput {
            outcome: &EtagGetOutcome::Failed,
            cached_payload: None,
            cached_detail: None,
            catalog_default_version: Some("v2.2.2"),
            catalog_description_en: None,
            repo_ok: true,
            is_auth_unauthorized: false,
        };
        match decide_detail_release(empty).unwrap() {
            DetailReleaseDecision::Proceed {
                release,
                synthesized_empty_failure,
                ..
            } => {
                assert_eq!(release.tag_name, "v2.2.2");
                assert!(release.assets.is_empty());
                assert!(!synthesized_empty_failure);
            }
            other => panic!("unexpected {other:?}"),
        }
        // 双亡 → 合成空失败（stale；401 文案独立于离线文案；无收录默认 v1.0.0）。
        for (auth, needle) in [(false, "离线模式"), (true, "GitHub 登录凭据已失效 (401)")]
        {
            let synth = DetailReleaseInput {
                outcome: &EtagGetOutcome::Failed,
                cached_payload: None,
                cached_detail: None,
                catalog_default_version: None,
                catalog_description_en: None,
                repo_ok: false,
                is_auth_unauthorized: auth,
            };
            match decide_detail_release(synth).unwrap() {
                DetailReleaseDecision::Proceed {
                    release,
                    synthesized_empty_failure,
                    ..
                } => {
                    assert_eq!(release.tag_name, "v1.0.0");
                    assert!(release.body.unwrap_or_default().contains(needle));
                    assert!(synthesized_empty_failure);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }
}
