use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// 深链入站统一经 `forge::canonical_lookup_id` 归一化（执行层仍校验并拒绝未知标识）。

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
pub enum DeepLinkAction {
    AppDetail {
        app_id: String,
    },
    InstallApp {
        app_id: String,
    },
    Search {
        query: String,
    },
    DeveloperProfile {
        owner: String,
    },
    OpenView {
        view: String,
    },
    /// 开源广场定位：切至 `launchpad` 视图并打开该新品详情（绝不自动安装）。
    LaunchpadApp {
        app_id: String,
    },
    /// 应用清单 / 专题合集预览：弹出合集预览弹窗（绝不静默自动安装）。
    Collection {
        title: String,
        note: Option<String>,
        app_ids: Vec<String>,
    },
}

pub struct DeepLinkParser;

/// 深链整体长度上限：外部输入直达的解析面，畸形超长 URL 直接拒绝。
const MAX_DEEPLINK_LEN: usize = 2048;
/// 合集深链单次最大允许包含的应用数量。
pub const MAX_COLLECTION_APPS: usize = 30;
/// 合集标题最大 Unicode 字符数。
pub const MAX_COLLECTION_TITLE_CHARS: usize = 60;
/// 合集备注最大 Unicode 字符数。
pub const MAX_COLLECTION_NOTE_CHARS: usize = 140;

/// 载荷解码 + 防御性过滤：解码失败回退原串（既有语义不变）；入参含 `%00` 或解码结果含
/// NUL 控制字符视为畸形输入返回 None（%00 注入面，正常 id/查询串不含 NUL）。
fn decode_payload(raw: &str) -> Option<String> {
    if raw.contains('\0') || raw.contains("%00") {
        return None;
    }
    let decoded = urlencoding::decode(raw)
        .unwrap_or(std::borrow::Cow::Borrowed(raw))
        .into_owned();
    (!decoded.contains('\0')).then_some(decoded)
}

/// 剥除全部控制字符（换行/制表符先转为空格）、折叠连续空白并按 Unicode 字符数截断。
fn sanitize_collection_text(raw: &str, max_chars: usize) -> String {
    let without_control: String = raw
        .chars()
        .map(|c| match c {
            '\r' | '\n' | '\t' => ' ',
            _ => c,
        })
        .filter(|c| !c.is_control())
        .collect();
    let collapsed = without_control
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(max_chars).collect()
}

/// 归一化、保序去重并截取最多 `MAX_COLLECTION_APPS` 条规范应用坐标。
pub(crate) fn normalize_collection_app_ids<'a>(
    raw_ids: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut app_ids: Vec<String> = Vec::new();
    for raw in raw_ids {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(canon) = crate::forge::canonical_app_id(trimmed) {
            if seen.insert(canon.clone()) {
                app_ids.push(canon);
                if app_ids.len() >= MAX_COLLECTION_APPS {
                    break;
                }
            }
        }
    }
    app_ids
}

/// 拆分并清洗合集 `ids`：先解码并校验全部片段（防止 30 条截断跳过尾部 `%00`），再按逗号归一化去重。
fn parse_collection_ids(raw_segments: &[&str]) -> Option<Vec<String>> {
    let mut decoded_segments: Vec<String> = Vec::with_capacity(raw_segments.len());
    for raw in raw_segments {
        decoded_segments.push(decode_payload(raw)?);
    }
    let app_ids =
        normalize_collection_app_ids(decoded_segments.iter().flat_map(|seg| seg.split(',')));
    (!app_ids.is_empty()).then_some(app_ids)
}

/// 解析 `zstore://collection`（支持标准查询与 `collection/{ids}` 简写）。
fn parse_collection_route(
    path_ids: Option<&str>,
    query_part: Option<&str>,
) -> Option<DeepLinkAction> {
    let mut title = String::new();
    let mut note: Option<String> = None;
    let mut raw_id_segments: Vec<&str> = Vec::new();

    if let Some(ids) = path_ids.map(str::trim).filter(|s| !s.is_empty()) {
        raw_id_segments.push(ids);
    }

    if let Some(query_str) = query_part {
        for pair in query_str.split('&') {
            if pair.is_empty() {
                continue;
            }
            let Some((raw_k, raw_v)) = pair.split_once('=') else {
                let _ = decode_payload(pair)?;
                continue;
            };
            let k = decode_payload(raw_k)?;
            if k == "ids" {
                // 对 `+` 不做空格替换（URL 坐标不含空格，若含空格会被 canonical_app_id 拒绝）。
                raw_id_segments.push(raw_v);
            } else if k == "title" {
                let with_spaces = raw_v.replace('+', " ");
                let decoded = decode_payload(&with_spaces)?;
                title = sanitize_collection_text(&decoded, MAX_COLLECTION_TITLE_CHARS);
            } else if k == "note" {
                let with_spaces = raw_v.replace('+', " ");
                let decoded = decode_payload(&with_spaces)?;
                let cleaned = sanitize_collection_text(&decoded, MAX_COLLECTION_NOTE_CHARS);
                note = (!cleaned.is_empty()).then_some(cleaned);
            } else {
                // 非目标键同样做 NUL 注入检测。
                let _ = decode_payload(raw_v)?;
            }
        }
    }

    let app_ids = parse_collection_ids(&raw_id_segments)?;
    Some(DeepLinkAction::Collection {
        title,
        note,
        app_ids,
    })
}

impl DeepLinkParser {
    pub fn parse(raw_url: &str) -> Option<DeepLinkAction> {
        let s = raw_url.trim();
        if s.is_empty() || s.len() > MAX_DEEPLINK_LEN || s.contains('\0') {
            return None;
        }

        // 必须以 zstore:// 开头 (大小写不敏感)。
        // 用 `get(..9)` 而非 `s[..9]`：第 9 字节落在多字节 UTF-8 字符中间时后者
        // 直接 panic（畸形深链即可崩进程），`get` 返回 None 一律按不匹配拒绝。
        let without_proto = if s
            .get(..9)
            .is_some_and(|p| p.eq_ignore_ascii_case("zstore://"))
        {
            &s[9..]
        } else {
            return None;
        };

        let after_scheme = without_proto.trim_start_matches('/');

        // 提取 query 参数 (例如 ?q=rustdesk)
        let (path_part, query_part) = match after_scheme.split_once('?') {
            Some((p, q)) => (p.trim_end_matches('/'), Some(q)),
            None => (after_scheme.trim_end_matches('/'), None),
        };

        // 1. 搜索路由：zstore://search?q={query}
        if path_part.eq_ignore_ascii_case("search") {
            if let Some(query_str) = query_part {
                for pair in query_str.split('&') {
                    if let Some((k, v)) = pair.split_once('=') {
                        if k == "q" {
                            let with_spaces = v.replace('+', " ");
                            let decoded = decode_payload(&with_spaces)?;
                            return Some(DeepLinkAction::Search { query: decoded });
                        }
                    }
                }
            }
            return Some(DeepLinkAction::Search {
                query: String::new(),
            });
        }

        // 2. 应用详情路由：zstore://app/{app_id}
        if let Some(app_id) = path_part.strip_prefix("app/") {
            let id = decode_payload(app_id)?;
            if !id.trim().is_empty() {
                return Some(DeepLinkAction::AppDetail {
                    app_id: crate::forge::canonical_lookup_id(&id),
                });
            }
        }

        // 3. 安装应用路由：zstore://install/{app_id}
        if let Some(app_id) = path_part.strip_prefix("install/") {
            let id = decode_payload(app_id)?;
            if !id.trim().is_empty() {
                return Some(DeepLinkAction::InstallApp {
                    app_id: crate::forge::canonical_lookup_id(&id),
                });
            }
        }

        // 4. 开发者主页路由：zstore://developer/{owner}
        if let Some(owner) = path_part.strip_prefix("developer/") {
            let o = decode_payload(owner)?;
            if !o.trim().is_empty() {
                return Some(DeepLinkAction::DeveloperProfile { owner: o });
            }
        }

        // 5. 视图切换路由：zstore://view/{view}
        if let Some(view) = path_part.strip_prefix("view/") {
            return Some(DeepLinkAction::OpenView {
                view: view.to_string(),
            });
        }

        // 6. 开源广场：zstore://launchpad → 视图；zstore://launchpad/{app_id} → 定位新品
        if path_part.eq_ignore_ascii_case("launchpad") {
            return Some(DeepLinkAction::OpenView {
                view: "launchpad".to_string(),
            });
        }
        if let Some(app_id) = path_part
            .get(..10)
            .filter(|p| p.eq_ignore_ascii_case("launchpad/"))
            .map(|_| &path_part[10..])
        {
            let id = decode_payload(app_id)?;
            if id.trim().is_empty() {
                return None;
            }
            return Some(DeepLinkAction::LaunchpadApp {
                app_id: crate::forge::canonical_lookup_id(&id),
            });
        }

        // 7. 应用清单 / 专题合集路由：zstore://collection?title=...&note=...&ids=... 或 zstore://collection/{ids}
        if path_part.eq_ignore_ascii_case("collection") {
            return parse_collection_route(None, query_part);
        }
        if let Some(rest) = path_part
            .get(..11)
            .filter(|p| p.eq_ignore_ascii_case("collection/"))
            .map(|_| &path_part[11..])
        {
            return parse_collection_route(Some(rest), query_part);
        }

        // 8. 如果直接是 zstore://{app_id} (例如 zstore://rustdesk 或 zstore://localsend/localsend)
        if !path_part.is_empty() && !path_part.contains('?') {
            let lower = path_part.to_lowercase();
            if lower == "app"
                || lower == "install"
                || lower == "developer"
                || lower == "view"
                || lower == "search"
                || lower == "launchpad"
                || lower == "collection"
            {
                return None;
            }
            let clean = decode_payload(path_part)?.trim().to_string();
            if !clean.is_empty() {
                return Some(DeepLinkAction::AppDetail {
                    app_id: crate::forge::canonical_lookup_id(&clean),
                });
            }
        }

        None
    }
}

#[cfg(target_os = "windows")]
pub fn register_windows_protocol() -> Result<bool, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = std::path::Path::new("Software")
        .join("Classes")
        .join("zstore");

    let (key, _) = hkcu
        .create_subkey_with_flags(&path, KEY_ALL_ACCESS)
        .map_err(|e| format!("无法创建注册表项: {}", e))?;

    key.set_value("", &"URL:ZStore Protocol")
        .map_err(|e| format!("设置默认值失败: {}", e))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("设置 URL Protocol 失败: {}", e))?;

    let exe_path =
        std::env::current_exe().map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;
    let cmd_str = format!("\"{}\" \"%1\"", exe_path.to_string_lossy());

    let (shell_cmd, _) = key
        .create_subkey_with_flags("shell\\open\\command", KEY_ALL_ACCESS)
        .map_err(|e| format!("无法创建 command 项: {}", e))?;

    shell_cmd
        .set_value("", &cmd_str)
        .map_err(|e| format!("设置命令失败: {}", e))?;

    Ok(true)
}

#[cfg(not(target_os = "windows"))]
pub fn register_windows_protocol() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_launchpad_routes() {
        let view = DeepLinkAction::OpenView {
            view: "launchpad".to_string(),
        };
        assert_eq!(
            DeepLinkParser::parse("zstore://view/launchpad"),
            Some(view.clone())
        );
        assert_eq!(
            DeepLinkParser::parse("zstore://launchpad"),
            Some(view.clone())
        );
        assert_eq!(
            DeepLinkParser::parse("zstore://launchpad/"),
            Some(view.clone())
        );
        assert_eq!(DeepLinkParser::parse("ZSTORE://Launchpad"), Some(view));
        assert_eq!(
            DeepLinkParser::parse("zstore://launchpad/Acme/Hyper-Term"),
            Some(DeepLinkAction::LaunchpadApp {
                app_id: "acme/hyper-term".to_string()
            })
        );
        assert_eq!(DeepLinkParser::parse("zstore://launchpad/%00bad"), None);
    }

    #[test]
    fn test_parse_app_detail() {
        let res = DeepLinkParser::parse("zstore://app/rustdesk/rustdesk").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk/rustdesk".to_string()
            }
        );

        // 简短直达语法
        let direct = DeepLinkParser::parse("zstore://localsend/localsend").unwrap();
        assert_eq!(
            direct,
            DeepLinkAction::AppDetail {
                app_id: "localsend/localsend".to_string()
            }
        );
    }

    #[test]
    fn test_parse_install_app() {
        let res = DeepLinkParser::parse("zstore://install/videolan/vlc").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::InstallApp {
                app_id: "videolan/vlc".to_string()
            }
        );
    }

    #[test]
    fn test_parse_search() {
        let res = DeepLinkParser::parse("zstore://search?q=video+editor").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::Search {
                query: "video editor".to_string()
            }
        );
    }

    #[test]
    fn test_parse_developer() {
        let res = DeepLinkParser::parse("zstore://developer/rustdesk").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::DeveloperProfile {
                owner: "rustdesk".to_string()
            }
        );
    }

    #[test]
    fn test_parse_view() {
        let res = DeepLinkParser::parse("zstore://view/settings").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::OpenView {
                view: "settings".to_string()
            }
        );
    }

    #[test]
    fn test_parse_encoded_and_utf8() {
        // 中文 UTF-8 查询测试
        let res = DeepLinkParser::parse("zstore://search?q=%E6%92%AD%E6%94%BE%E5%99%A8").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::Search {
                query: "播放器".to_string()
            }
        );

        // 编码斜杠应用 ID
        let res2 = DeepLinkParser::parse("zstore://app/localsend%2Flocalsend").unwrap();
        assert_eq!(
            res2,
            DeepLinkAction::AppDetail {
                app_id: "localsend/localsend".to_string()
            }
        );
    }

    #[test]
    fn test_parse_app_id_normalizes_canonical() {
        let mixed = DeepLinkParser::parse("zstore://app/RustDesk/RustDesk").unwrap();
        assert_eq!(
            mixed,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk/rustdesk".to_string()
            }
        );
        let url_form =
            DeepLinkParser::parse("zstore://app/https://github.com/RustDesk/RustDesk").unwrap();
        assert_eq!(
            url_form,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk/rustdesk".to_string()
            }
        );
        let install = DeepLinkParser::parse("zstore://install/VideoLAN/VLC").unwrap();
        assert_eq!(
            install,
            DeepLinkAction::InstallApp {
                app_id: "videolan/vlc".to_string()
            }
        );
        // 单段裸 id 不可解析：小写回退（执行层 `require_app_id` 再拒绝），不断路由。
        let bare = DeepLinkParser::parse("zstore://RustDesk").unwrap();
        assert_eq!(
            bare,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk".to_string()
            }
        );
    }

    #[test]
    fn test_parse_invalid() {
        assert!(DeepLinkParser::parse("https://google.com").is_none());
        assert!(DeepLinkParser::parse("").is_none());
        assert!(DeepLinkParser::parse("zstore://app").is_none());
        assert!(DeepLinkParser::parse("zstore://app/").is_none());
        assert!(DeepLinkParser::parse("zstore://install").is_none());
        assert!(DeepLinkParser::parse("zstore://install/").is_none());
        assert!(DeepLinkParser::parse("zstore://developer").is_none());
        assert!(DeepLinkParser::parse("zstore://developer/").is_none());
    }

    #[test]
    fn multibyte_at_prefix_boundary_does_not_panic() {
        // 第 9 字节落在多字节 UTF-8 字符中间：按字节切片会 panic（畸形深链
        // 即可崩进程），必须按不匹配拒绝。
        assert!(DeepLinkParser::parse("zstore:/é").is_none());
        assert!(DeepLinkParser::parse("ZSTORE:/é").is_none());
        assert!(DeepLinkParser::parse("zstore:/播放器").is_none());
        // 大小写不敏感前缀语义保留
        let res = DeepLinkParser::parse("ZSTORE://app/rustdesk/rustdesk").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk/rustdesk".to_string()
            }
        );
    }

    #[test]
    fn oversized_deeplink_rejected() {
        let long = format!("zstore://app/{}", "a".repeat(4096));
        assert!(DeepLinkParser::parse(&long).is_none());
        let ok = format!("zstore://app/{}", "a".repeat(64));
        assert!(DeepLinkParser::parse(&ok).is_some());
    }

    #[test]
    fn nul_payload_rejected_and_decode_fallback_kept() {
        // %00 解码为 NUL：畸形载荷整链拒绝
        assert!(DeepLinkParser::parse("zstore://app/foo%00bar").is_none());
        assert!(DeepLinkParser::parse("zstore://search?q=%00").is_none());
        assert!(DeepLinkParser::parse("zstore://install/a%00b").is_none());
        // 解码失败回退原串的既有语义保留（非法编码不 panic、不断路由）
        assert!(DeepLinkParser::parse("zstore://app/%FF%FE").is_some());
    }

    #[test]
    fn collection_parses_query_and_shorthand_formats() {
        let query = DeepLinkParser::parse(
            "zstore://collection?title=Rust+%E8%A3%85%E6%9C%BA&note=%E5%BC%80%E5%8F%91%E5%BF%85%E5%A4%87&ids=RustDesk/RustDesk,localsend/localsend",
        )
        .unwrap();
        assert_eq!(
            query,
            DeepLinkAction::Collection {
                title: "Rust 装机".to_string(),
                note: Some("开发必备".to_string()),
                app_ids: vec![
                    "rustdesk/rustdesk".to_string(),
                    "localsend/localsend".to_string(),
                ],
            }
        );

        let encoded = DeepLinkParser::parse(
            "ZSTORE://Collection?ids=rustdesk%2Frustdesk%2Ccodeberg%3AFreeTubeApp%2FFreeTube",
        )
        .unwrap();
        assert_eq!(
            encoded,
            DeepLinkAction::Collection {
                title: String::new(),
                note: None,
                app_ids: vec![
                    "rustdesk/rustdesk".to_string(),
                    "codeberg:freetubeapp/freetube".to_string(),
                ],
            }
        );

        let shorthand = DeepLinkParser::parse(
            "zstore://collection/rustdesk/rustdesk,gitlab:Inkscape/Inkscape?title=Media+Pack",
        )
        .unwrap();
        assert_eq!(
            shorthand,
            DeepLinkAction::Collection {
                title: "Media Pack".to_string(),
                note: None,
                app_ids: vec![
                    "rustdesk/rustdesk".to_string(),
                    "gitlab:inkscape/inkscape".to_string(),
                ],
            }
        );
    }

    #[test]
    fn collection_dedups_filters_invalid_and_caps_at_30() {
        let mut raw_ids = vec![
            "bad-single".to_string(),
            "RustDesk/RustDesk".to_string(),
            "https://github.com/rustdesk/rustdesk".to_string(),
            "invalid id!".to_string(),
        ];
        for i in 0..40 {
            raw_ids.push(format!("Owner{i}/Repo{i}"));
        }
        let url = format!("zstore://collection?ids={}", raw_ids.join(","));
        let parsed = DeepLinkParser::parse(&url).unwrap();
        let DeepLinkAction::Collection { app_ids, .. } = parsed else {
            panic!("expected Collection");
        };
        assert_eq!(app_ids.len(), MAX_COLLECTION_APPS);
        assert_eq!(app_ids[0], "rustdesk/rustdesk");
        assert_eq!(app_ids[1], "owner0/repo0");
        assert_eq!(app_ids[29], "owner28/repo28");

        // 全无效或空列表返回 None
        assert!(DeepLinkParser::parse("zstore://collection").is_none());
        assert!(DeepLinkParser::parse("zstore://collection/").is_none());
        assert!(DeepLinkParser::parse("zstore://collection?ids=").is_none());
        assert!(DeepLinkParser::parse("zstore://collection?ids=bad1,not_a_repo").is_none());
        assert!(DeepLinkParser::parse("zstore://collection/invalid-only").is_none());
    }

    #[test]
    fn collection_rejects_nul_oversized_and_sanitizes_text() {
        // %00 NUL 注入拦截（含超出 30 条后的尾部片段）
        assert!(DeepLinkParser::parse("zstore://collection?ids=a/b,%00").is_none());
        assert!(DeepLinkParser::parse("zstore://collection?title=hi%00&ids=a/b").is_none());
        assert!(DeepLinkParser::parse("zstore://collection?note=%00&ids=a/b").is_none());
        let thirty_ids = (0..30)
            .map(|i| format!("o{i}/r{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let trailing_seg = format!("zstore://collection/{thirty_ids}?ids=%00");
        assert!(DeepLinkParser::parse(&trailing_seg).is_none());
        let trailing_comma = format!("zstore://collection?ids={thirty_ids},x%00y");
        assert!(DeepLinkParser::parse(&trailing_comma).is_none());

        // 超长 2048 拒绝
        let huge_ids = (0..200)
            .map(|i| format!("owner{i}/repo{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let over_url = format!("zstore://collection?ids={huge_ids}");
        assert!(over_url.len() > MAX_DEEPLINK_LEN);
        assert!(DeepLinkParser::parse(&over_url).is_none());

        // 控制字符剥除、换行/制表转空格折叠与 Unicode 字符上限截断（控制整体编码长度 < 2048）
        let long_title = format!("  A\x07\x1B   {}  ", "字".repeat(70));
        let long_note = format!("\t\n{}\r\n", "n".repeat(160));
        let url = format!(
            "zstore://collection?title={}&note={}&ids=a/b",
            urlencoding::encode(&long_title),
            urlencoding::encode(&long_note),
        );
        assert!(url.len() <= MAX_DEEPLINK_LEN);
        let parsed = DeepLinkParser::parse(&url).unwrap();
        let DeepLinkAction::Collection { title, note, .. } = parsed else {
            panic!("expected Collection");
        };
        assert_eq!(title.chars().count(), MAX_COLLECTION_TITLE_CHARS);
        assert!(title.starts_with("A "));
        assert!(!title.chars().any(char::is_control));

        let note = note.unwrap();
        assert_eq!(note.chars().count(), MAX_COLLECTION_NOTE_CHARS);
        assert!(!note.chars().any(char::is_control));

        let multiline =
            DeepLinkParser::parse("zstore://collection?title=hello%0Aworld&note=foo%09bar&ids=a/b")
                .unwrap();
        assert_eq!(
            multiline,
            DeepLinkAction::Collection {
                title: "hello world".to_string(),
                note: Some("foo bar".to_string()),
                app_ids: vec!["a/b".to_string()],
            }
        );

        // 仅空白或控制字符的 note 归一为 None
        let blank_note =
            DeepLinkParser::parse("zstore://collection?note=%07%20%09&ids=a/b").unwrap();
        assert_eq!(
            blank_note,
            DeepLinkAction::Collection {
                title: String::new(),
                note: None,
                app_ids: vec!["a/b".to_string()],
            }
        );
    }
}
