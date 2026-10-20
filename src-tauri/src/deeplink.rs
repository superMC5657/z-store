use serde::{Deserialize, Serialize};

// ADR-0010 契约：深链入站强制经 `canonical_app_id()` 归一化——
// `app`/`install`/裸 id 三路由统一走 `forge::canonical_lookup_id`
//（可解析直取 canonical，不可解析回退小写不断路由；执行层 `require_app_id`
// 仍拒绝未知标识，分层不混淆）。详见 ADR-0010。

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "snake_case")]
pub enum DeepLinkAction {
    AppDetail { app_id: String },
    InstallApp { app_id: String },
    Search { query: String },
    DeveloperProfile { owner: String },
    OpenView { view: String },
}

pub struct DeepLinkParser;

/// 深链整体长度上限：外部输入直达的解析面，畸形超长 URL 直接拒绝。
const MAX_DEEPLINK_LEN: usize = 2048;

/// 载荷解码 + 防御性过滤：解码失败回退原串（既有语义不变）；解码结果含
/// NUL 控制字符视为畸形输入返回 None（%00 注入面，正常 id/查询串不含 NUL）。
fn decode_payload(raw: &str) -> Option<String> {
    let decoded = urlencoding::decode(raw)
        .unwrap_or(std::borrow::Cow::Borrowed(raw))
        .into_owned();
    (!decoded.contains('\0')).then_some(decoded)
}

impl DeepLinkParser {
    pub fn parse(raw_url: &str) -> Option<DeepLinkAction> {
        let s = raw_url.trim();
        if s.is_empty() || s.len() > MAX_DEEPLINK_LEN {
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
        // ADR-0010 契约：入站强制归一化（canonical 或小写回退，见模块注）。
        if let Some(app_id) = path_part.strip_prefix("app/") {
            let id = decode_payload(app_id)?;
            if !id.trim().is_empty() {
                return Some(DeepLinkAction::AppDetail {
                    app_id: crate::forge::canonical_lookup_id(&id),
                });
            }
        }

        // 3. 安装应用路由：zstore://install/{app_id}
        // ADR-0010 契约：入站强制归一化（canonical 或小写回退，见模块注）。
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

        // 6. 如果直接是 zstore://{app_id} (例如 zstore://rustdesk 或 zstore://localsend/localsend)
        if !path_part.is_empty() && !path_part.contains('?') {
            let lower = path_part.to_lowercase();
            if lower == "app"
                || lower == "install"
                || lower == "developer"
                || lower == "view"
                || lower == "search"
            {
                return None;
            }
            let clean = decode_payload(path_part)?.trim().to_string();
            if !clean.is_empty() {
                // ADR-0010 契约：裸 id 路由同样强制归一化。
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
    fn test_parse_app_detail() {
        // ADR-0010：应用 id 为 canonical owner/repo
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
        // ADR-0010 契约：深链入站强制归一化（大小写/URL 形态归一为 canonical；
        // 不可解析回退小写，解析层不断路由）。
        let mixed = DeepLinkParser::parse("zstore://app/RustDesk/RustDesk").unwrap();
        assert_eq!(
            mixed,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk/rustdesk".to_string()
            }
        );
        let url_form = DeepLinkParser::parse("zstore://app/https://github.com/RustDesk/RustDesk").unwrap();
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
}
