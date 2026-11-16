//! macOS 应用包发现：`/Applications` 与 `~/Applications` 下 `*.app/Contents/Info.plist`。
//! XML plist 解析是纯函数（跨平台可测）；二进制 plist 经 `/usr/bin/plutil` 转 XML。

/// `Info.plist` 中与匹配相关的字段。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MacBundleMeta {
    pub display_name: Option<String>,
    pub name: Option<String>,
    pub identifier: Option<String>,
    pub short_version: Option<String>,
    pub version: Option<String>,
    pub executable: Option<String>,
}

impl MacBundleMeta {
    /// 展示名：`CFBundleDisplayName` 优先，其次 `CFBundleName`。
    pub fn title(&self) -> Option<&str> {
        self.display_name.as_deref().or(self.name.as_deref())
    }

    /// 版本：`CFBundleShortVersionString` 优先，其次 `CFBundleVersion`。
    pub fn version_string(&self) -> Option<&str> {
        self.short_version.as_deref().or(self.version.as_deref())
    }
}

/// 反转义 XML 文本中的预定义实体。
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 解析 XML 形态 `Info.plist` 顶层 dict 中的字符串键值。
pub fn parse_info_plist_xml(xml: &str) -> Option<MacBundleMeta> {
    let mut meta = MacBundleMeta::default();
    let mut found = false;
    let mut rest = xml;
    while let Some(k_start) = rest.find("<key>") {
        let after_key = &rest[k_start + 5..];
        let k_end = after_key.find("</key>")?;
        let key = after_key[..k_end].trim();
        let after = after_key[k_end + 6..].trim_start();
        rest = after;
        let Some(value_body) = after.strip_prefix("<string>") else {
            continue;
        };
        let Some(v_end) = value_body.find("</string>") else {
            break;
        };
        let value = xml_unescape(value_body[..v_end].trim());
        rest = &value_body[v_end + 9..];
        if value.is_empty() {
            continue;
        }
        let slot = match key {
            "CFBundleDisplayName" => &mut meta.display_name,
            "CFBundleName" => &mut meta.name,
            "CFBundleIdentifier" => &mut meta.identifier,
            "CFBundleShortVersionString" => &mut meta.short_version,
            "CFBundleVersion" => &mut meta.version,
            "CFBundleExecutable" => &mut meta.executable,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value);
            found = true;
        }
    }
    found.then_some(meta)
}

#[cfg(target_os = "macos")]
impl super::AppScanner {
    /// 扫描 `/Applications` 与 `~/Applications` 下一层 `*.app`。
    pub(crate) fn scan_macos_apps() -> Vec<super::ScannedRawApp> {
        use std::path::PathBuf;
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        let mut out = Vec::new();
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let bundle = entry.path();
                if !bundle.is_dir()
                    || !bundle
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
                {
                    continue;
                }
                let Some(meta) = read_info_plist(&bundle.join("Contents").join("Info.plist"))
                else {
                    continue;
                };
                let bundle_str = bundle.to_string_lossy().to_string();
                let title = meta.title().map(str::to_string).unwrap_or_else(|| {
                    bundle
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                });
                let binary = meta
                    .executable
                    .as_deref()
                    .map(|exe| bundle.join("Contents").join("MacOS").join(exe))
                    .filter(|p| p.is_file())
                    .map(|p| p.to_string_lossy().to_string());
                out.push(super::ScannedRawApp {
                    display_name: title,
                    display_version: meta.version_string().unwrap_or("").to_string(),
                    install_location: Some(bundle_str.clone()),
                    display_icon: binary.or_else(|| Some(bundle_str.clone())),
                    installed_at: Self::detect_path_installed_at(&bundle_str),
                    registry_key: meta.identifier.clone(),
                    source_kind: Some(super::types::SourceKind::MacosApp),
                    ..Default::default()
                });
            }
        }
        out
    }
}

/// 读取 `Info.plist`：XML 直接解析，二进制 plist（`bplist00`）先经 `plutil` 转 XML。
#[cfg(target_os = "macos")]
fn read_info_plist(path: &std::path::Path) -> Option<MacBundleMeta> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.starts_with(b"bplist00") {
        let out = std::process::Command::new("/usr/bin/plutil")
            .args(["-convert", "xml1", "-o", "-"])
            .arg(path)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        return parse_info_plist_xml(&String::from_utf8_lossy(&out.stdout));
    }
    parse_info_plist_xml(&String::from_utf8_lossy(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VSCODE_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>English</string>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Bash script</string>
		</dict>
	</array>
	<key>CFBundleDisplayName</key>
	<string>Code</string>
	<key>CFBundleExecutable</key>
	<string>Electron</string>
	<key>CFBundleIdentifier</key>
	<string>com.microsoft.VSCode</string>
	<key>CFBundleName</key>
	<string>Visual Studio Code</string>
	<key>CFBundleShortVersionString</key>
	<string>1.92.0</string>
	<key>CFBundleVersion</key>
	<string>1.92.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.15</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>"#;

    #[test]
    fn parses_core_bundle_fields() {
        let meta = parse_info_plist_xml(VSCODE_PLIST).expect("parsed");
        assert_eq!(meta.display_name.as_deref(), Some("Code"));
        assert_eq!(meta.name.as_deref(), Some("Visual Studio Code"));
        assert_eq!(meta.identifier.as_deref(), Some("com.microsoft.VSCode"));
        assert_eq!(meta.short_version.as_deref(), Some("1.92.0"));
        assert_eq!(meta.executable.as_deref(), Some("Electron"));
        assert_eq!(meta.title(), Some("Code"));
        assert_eq!(meta.version_string(), Some("1.92.0"));
    }

    #[test]
    fn nested_dict_keys_do_not_override_top_level_and_entities_unescape() {
        let xml = r#"<plist><dict>
            <key>CFBundleName</key><string>Tom &amp; Jerry</string>
            <key>CFBundleVersion</key><string>42</string>
        </dict></plist>"#;
        let meta = parse_info_plist_xml(xml).unwrap();
        assert_eq!(meta.title(), Some("Tom & Jerry"));
        assert_eq!(meta.version_string(), Some("42"));
        assert!(parse_info_plist_xml("<plist><dict></dict></plist>").is_none());
        assert!(parse_info_plist_xml("<key>CFBundleName").is_none());
    }
}
