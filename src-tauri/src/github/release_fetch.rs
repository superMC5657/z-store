//! Release 拉取深模块：`releases/latest` ETag GET 缝合处唯一真相源。
//!
//! 领域术语：ETag Cache（条件请求缓存）、Cache TTL（缓存生存时效）、
//! Streaming Update Check（流式更新检查）、Checksum Manifest（校验清单）。
//!
//! 本模块收敛三份逐字重复的 ETag 304-touch/save/回退分支，对外仅暴露两个 adapter：
//! - shallow（轻量）：tag + body 投影（附 assets 最小投影，仅供平台推导），
//!   供 Streaming Update Check（流式更新检查）与 `get_platforms_lite` 共用；
//!   无 repo、无 README、无 Checksum Manifest（校验清单）开销——
//!   仅单次 `releases/latest` 条件请求，更新检查结果与原来一致。
//! - deep（详情）：完整 release 决议（含落库元组与 stale 复用），供 `fetch_app_detail`；
//!   调用方继续 repo + README + Checksum Manifest（校验清单）抓取与平台推导。
//!
//! ADR-0007 豁免（不重开，原语义以注释 + 分支形状编码于此，勿"修复"）：
//! Streaming Update Check（流式更新检查）永不查 Cache TTL（缓存生存时效）——
//! 每次直探 ETag（304 零配额），"有更新"提示不受详情浏览 TTL 拖累。
//! 编码方式：本模块故意不设任何 TTL 参数（ETag 决议与 TTL 正交）；
//! - consult_ttl = true 侧：`get_platforms_lite` 入口保留 `if TTL-hit → return` 快径分支，
//!   进本模块前已先查 Cache TTL；
//! - consult_ttl = false 侧：`fetch_app_latest_version_lightweight` 无此分支，每次直探。
//!
//!   两侧经同一 shallow adapter 决议（单测同 interface），豁免由分支形状保证。
//!
//! effect 归属：本模块为纯决议（无网络、无 DB），只返回 touch/save 意图；
//! 调用方各用 2 行执行——304 命中恢复一律 touch 延保，stale 穿透永不 touch
//! （避免把过期 stale 洗成 fresh），Fresh 带 ETag 则 `save_etag`。
//! 失败路径是否恢复 ETag payload 由调用方传入决定：更新检查传入 None（不恢复，
//! 现行语义），平台 lite 传入预读 payload；差异见各调用方注释。

use super::models::{GitHubAssetResponse, GitHubReleaseResponse};
use crate::github::http::EtagGetOutcome;
use crate::models::AppDetail;

/// release payload 解析（deep/shallow 共用唯一解析口；错误串由调用方按上下文包装）。
fn parse_release_payload(text: &str) -> Result<GitHubReleaseResponse, serde_json::Error> {
    serde_json::from_str::<GitHubReleaseResponse>(text)
}

// ---------------------------------------------------------------------------
// shallow adapter：Streaming Update Check（流式更新检查）+ `get_platforms_lite` 共用
// ---------------------------------------------------------------------------

/// shallow adapter 投影来源（调用方据此做平台推导与 stale 标记）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShallowSource {
    /// 远端 200 新 payload。
    Fresh,
    /// 304 或离线时 ETag payload 恢复。
    Payload,
    /// 旧详情行穿透。
    StaleRow,
    /// 收录库默认版本。
    Catalog,
}

/// shallow adapter 决议：轻量 tag + body（附 assets 最小投影，仅供平台推导）。
#[derive(Debug)]
pub(crate) struct ShallowRelease {
    pub tag: String,
    pub body: String,
    pub assets: Vec<GitHubAssetResponse>,
    pub source: ShallowSource,
    /// 304 命中恢复：调用方应 touch 详情 `cached_at` 延保；Fresh/失败穿透为 false。
    pub touch: bool,
    /// 远端 200 且带 ETag：调用方负责 `save_etag`；其余为 None。
    pub cache_to_save: Option<(String, String)>,
    /// 旧行复用时回显其已 deduce platforms（调用方直接采用，不重推导）；其余为 None。
    pub row_platforms: Option<Vec<String>>,
    /// stale 语义（`get_platforms_lite` 直用，更新检查忽略）：
    /// Fresh/Payload/Catalog 为 None；Row 在 304 时回显旧行值，失败穿透时为 Some(true)。
    pub stale: Option<bool>,
}

/// shallow adapter 未命中：调用方按自身语义映射
/// （更新检查全 Err；lite 在离线时给空-stale，304 缺缓存时 Err）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShallowMiss {
    /// 304 但 payload 缺/坏且无行无收录。
    NotModifiedWithoutCache,
    /// 失败且 payload/行/收录全空。
    OfflineWithoutCache,
}

/// shallow adapter 错误：解析串已在模块内包装为现行文案（三处旧分支逐字收敛）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ShallowError {
    /// 远端 200 payload 解析失败（"解析 GitHub Release 失败: ..."）。
    Parse(String),
    /// 304 时 ETag payload 腐坏（"解析本地 ETag 缓存失败: ..."）。
    /// 仅 304 抛出（lite-304 硬错现行语义）；失败路径 tolerant 跳过（lite-离线现行语义）；
    /// 更新检查以 payload=None 重试，复现其 tolerant 跳过语义。
    PayloadCorrupt(String),
    Miss(ShallowMiss),
}

fn row_release(row: &AppDetail, touch: bool, stale: Option<bool>) -> ShallowRelease {
    ShallowRelease {
        tag: row.latest_version.clone(),
        body: row.changelog.clone(),
        assets: Vec::new(),
        source: ShallowSource::StaleRow,
        touch,
        cache_to_save: None,
        row_platforms: Some(row.platforms.clone()),
        stale,
    }
}

/// shallow adapter 入口（纯函数，无网络无 DB；更新检查 + platforms-lite 同一 interface）。
///
/// - `outcome`：单次 `releases/latest` ETag GET 结果（调用方保留 log_tag：
///   "updates" / "platforms-lite"，诊断可 grep）。
/// - `cached_payload`：ETag Cache（条件请求缓存）预读 payload；更新检查在失败路径
///   传入 None（不恢复，现行语义），仅 304 时传入。
/// - `stale_row`：旧详情行回退源（无行时 None）。
/// - `catalog_default_version`：收录库默认版本（lite 通道无此回退，传 None）。
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
            // 失败路径 tolerant：payload 腐坏直接跳过（lite-离线 `if let Ok` 现行语义）。
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
    /// 收录库人工精校简介（无收录项或无字段时为 None；与旧分支 `is_some` 门控同形）。
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

/// deep adapter 入口（纯函数；`fetch_app_detail` 的 release 段逐字搬迁，语义不变）。
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
                    reused.description_en = Some(desc_en.to_string());
                }
                reused.is_stale = Some(true);
                return Ok(DetailReleaseDecision::ReuseStale(Box::new(reused)));
            }
            if let Some(payload) = input.cached_payload {
                let parsed = parse_release_payload(payload)
                    .map_err(|e| format!("解析离线缓存失败: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            changelog: "old notes".to_string(),
            is_verified: false,
            readme_markdown: "# r".to_string(),
            readme_variants: None,
            releases: vec![],
            category: "dev".to_string(),
            category_name: "开发工具".to_string(),
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            cached_at: None,
            is_stale: None,
            homepage: None,
            platforms: vec!["windows".to_string()],
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
        let err =
            decide_shallow_release(&outcome, Some("corrupt"), Some(&row), Some("v9.9.9"))
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
            let rel =
                decide_shallow_release(&outcome, Some(&payload), Some(&row), Some("v9.9.9"))
                    .unwrap();
            assert_eq!(rel.source, ShallowSource::Payload);
            assert!(!rel.touch);
            assert!(rel.cache_to_save.is_none());
            assert!(rel.stale.is_none());
            // 行穿透：失败时 stale 恒 Some(true)，永不 touch。
            let rel =
                decide_shallow_release(&outcome, None, Some(&row), Some("v9.9.9")).unwrap();
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
                assert_eq!(reused.latest_version, "v1.0.0");
                assert_eq!(reused.description_en.as_deref(), Some("Curated EN"));
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
                assert_eq!(reused.description_en.as_deref(), Some("EN"));
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
        assert!(decide_detail_release(bad).unwrap_err().starts_with("解析离线缓存失败"));
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
        for (auth, needle) in [
            (false, "离线模式"),
            (true, "GitHub 登录凭据已失效 (401)"),
        ] {
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
