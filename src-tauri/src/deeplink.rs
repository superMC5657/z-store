use serde::{Deserialize, Serialize};

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

impl DeepLinkParser {
    pub fn parse(raw_url: &str) -> Option<DeepLinkAction> {
        let s = raw_url.trim();
        if s.is_empty() {
            return None;
        }

        // 必须以 zstore:// 开头 (大小写不敏感)
        let without_proto = if s.len() >= 9 && s[..9].eq_ignore_ascii_case("zstore://") {
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

        // 1. zstore://search?q={query}
        if path_part.eq_ignore_ascii_case("search") {
            if let Some(query_str) = query_part {
                for pair in query_str.split('&') {
                    if let Some((k, v)) = pair.split_once('=') {
                        if k.eq_ignore_ascii_case("q") || k.eq_ignore_ascii_case("query") {
                            let with_spaces = v.replace('+', " ");
                            let decoded = urlencoding::decode(&with_spaces).unwrap_or_else(|_| with_spaces.as_str().into());
                            return Some(DeepLinkAction::Search {
                                query: decoded.to_string(),
                            });
                        }
                    }
                }
            }
            return Some(DeepLinkAction::Search {
                query: String::new(),
            });
        }

        // 2. zstore://app/{app_id}
        if let Some(app_id) = path_part.strip_prefix("app/") {
            let id = urlencoding::decode(app_id).unwrap_or_else(|_| app_id.into());
            if !id.trim().is_empty() {
                return Some(DeepLinkAction::AppDetail {
                    app_id: id.to_string(),
                });
            }
        }

        // 3. zstore://install/{app_id}
        if let Some(app_id) = path_part.strip_prefix("install/") {
            let id = urlencoding::decode(app_id).unwrap_or_else(|_| app_id.into());
            if !id.trim().is_empty() {
                return Some(DeepLinkAction::InstallApp {
                    app_id: id.to_string(),
                });
            }
        }

        // 4. zstore://developer/{owner}
        if let Some(owner) = path_part.strip_prefix("developer/") {
            let o = urlencoding::decode(owner).unwrap_or_else(|_| owner.into());
            if !o.trim().is_empty() {
                return Some(DeepLinkAction::DeveloperProfile {
                    owner: o.to_string(),
                });
            }
        }

        // 5. zstore://view/{view}
        if let Some(view) = path_part.strip_prefix("view/") {
            return Some(DeepLinkAction::OpenView {
                view: view.to_string(),
            });
        }

        // 6. 如果直接是 zstore://{app_id} (例如 zstore://rustdesk 或 zstore://localsend/localsend)
        if !path_part.is_empty() && !path_part.contains('?') {
            let lower = path_part.to_lowercase();
            if lower == "app" || lower == "install" || lower == "developer" || lower == "view" || lower == "search" {
                return None;
            }
            let id = urlencoding::decode(path_part).unwrap_or_else(|_| path_part.into());
            let clean = id.trim();
            if !clean.is_empty() {
                return Some(DeepLinkAction::AppDetail {
                    app_id: clean.to_string(),
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
    let path = std::path::Path::new("Software").join("Classes").join("zstore");

    let (key, _) = hkcu
        .create_subkey_with_flags(&path, KEY_ALL_ACCESS)
        .map_err(|e| format!("无法创建注册表项: {}", e))?;

    key.set_value("", &"URL:ZStore Protocol")
        .map_err(|e| format!("设置默认值失败: {}", e))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("设置 URL Protocol 失败: {}", e))?;

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {}", e))?;
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
        let res = DeepLinkParser::parse("zstore://app/rustdesk").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::AppDetail {
                app_id: "rustdesk".to_string()
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
        let res = DeepLinkParser::parse("zstore://install/vlc").unwrap();
        assert_eq!(
            res,
            DeepLinkAction::InstallApp {
                app_id: "vlc".to_string()
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
}
