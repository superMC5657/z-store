//! Linux 应用发现：7 类 XDG 目录下的 `*.desktop` 与 `~/Applications`、`~/AppImages` 下的裸 AppImage；
//! 版本缺失且主程序位于系统目录时按所属 `dpkg` / `rpm` 包反查上游版本。
//! 桌面文件解析与包版本净化均为纯函数，跨平台可单测。

#[cfg(target_os = "linux")]
use super::types::SourceKind;
use super::AppScanner;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

/// `[Desktop Entry]` 节解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDesktopEntry {
    pub name: String,
    /// 仅取 `X-AppImage-Version=`；`Version=` 是 Desktop Entry 规范版本（如 `1.0`），不是软件版本。
    pub version: String,
    pub exec_bin: Option<String>,
    pub try_exec: Option<String>,
    pub icon: Option<String>,
}

/// 解析 `.desktop` 文件内容：只读 `[Desktop Entry]` 节（`[Desktop Action ...]` 等节忽略）；
/// `Hidden=true`、`NoDisplay=true` 或非 `Application` 类型返回 None；无 `Name=` 时用文件名。
pub fn parse_desktop_entry_content(stem: &str, content: &str) -> Option<ParsedDesktopEntry> {
    let mut in_main = false;
    let mut name: Option<String> = None;
    let mut version = String::new();
    let mut type_val = String::new();
    let mut hidden = false;
    let mut exec_bin: Option<String> = None;
    let mut try_exec: Option<String> = None;
    let mut icon: Option<String> = None;
    let non_empty = |v: &str| Some(v.trim().to_string()).filter(|s| !s.is_empty());

    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_main = t == "[Desktop Entry]";
            continue;
        }
        if !in_main || t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(v) = t.strip_prefix("Name=") {
            name = name.or_else(|| non_empty(v));
        } else if let Some(v) = t.strip_prefix("X-AppImage-Version=") {
            if version.is_empty() {
                version = v.trim().to_string();
            }
        } else if let Some(v) = t.strip_prefix("Type=") {
            if type_val.is_empty() {
                type_val = v.trim().to_string();
            }
        } else if let Some(v) = t.strip_prefix("Hidden=") {
            hidden |= v.trim().eq_ignore_ascii_case("true");
        } else if let Some(v) = t.strip_prefix("NoDisplay=") {
            hidden |= v.trim().eq_ignore_ascii_case("true");
        } else if let Some(v) = t.strip_prefix("TryExec=") {
            try_exec = try_exec.or_else(|| non_empty(v));
        } else if t.starts_with("Exec=") {
            exec_bin = exec_bin.or_else(|| AppScanner::parse_desktop_exec_binary(t));
        } else if let Some(v) = t.strip_prefix("Icon=") {
            icon = icon.or_else(|| non_empty(v));
        }
    }
    if hidden || (!type_val.is_empty() && !type_val.eq_ignore_ascii_case("Application")) {
        return None;
    }
    let name = name.unwrap_or_else(|| stem.to_string());
    if name.trim().is_empty() {
        return None;
    }
    Some(ParsedDesktopEntry {
        name,
        version,
        exec_bin,
        try_exec,
        icon,
    })
}

/// 发行版包版本 → 上游版本：去 epoch（`1:`），再去打包修订（`-1ubuntu2`、`-1.fc40`）
/// 与 `+dfsg`、`~` 等后缀。
pub fn clean_distro_package_version(raw: &str) -> String {
    let v = raw.trim();
    let v = match v.split_once(':') {
        Some((epoch, rest)) if !epoch.is_empty() && epoch.chars().all(|c| c.is_ascii_digit()) => {
            rest
        }
        _ => v,
    };
    let end = v.find(['-', '+', '~']).unwrap_or(v.len());
    v[..end].to_string()
}

/// `dpkg-query -S` 输出 → 路径到包名（多架构 `pkg:amd64` 去架构后缀；`diversion` 行忽略）。
pub fn parse_dpkg_search_output(out: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        if line.starts_with("diversion") {
            continue;
        }
        let Some((pkgs, path)) = line.split_once(": ") else {
            continue;
        };
        let pkg = pkgs.split(',').next().unwrap_or("").trim();
        let pkg = pkg.split(':').next().unwrap_or(pkg);
        if !pkg.is_empty() {
            map.insert(path.trim().to_string(), pkg.to_string());
        }
    }
    map
}

/// `dpkg-query -W -f='${Package}\t${Version}\n'` 输出 → 包名到版本。
pub fn parse_dpkg_versions(out: &str) -> std::collections::HashMap<String, String> {
    out.lines()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(p, v)| !p.trim().is_empty() && !v.trim().is_empty())
        .map(|(p, v)| (p.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// AppImage 文件名 → (名称, 版本)：`Motrix-1.8.19-x86_64` → (`Motrix`, `1.8.19`)。
pub fn parse_appimage_stem(stem: &str) -> (String, String) {
    const ARCH: &[&str] = &[
        "x86_64", "amd64", "aarch64", "arm64", "x64", "i386", "armhf",
    ];
    let parts: Vec<&str> = stem.split(['-', '_']).filter(|p| !p.is_empty()).collect();
    let mut name_parts: Vec<&str> = Vec::new();
    let mut version = String::new();
    let mut i = 0;
    while i < parts.len() {
        let p = parts[i];
        let lower = p.to_lowercase();
        // `x86_64` 被 `_` 拆成两段，此处重新拼回识别
        let joined = parts
            .get(i + 1)
            .map(|n| format!("{lower}_{}", n.to_lowercase()));
        if ARCH.contains(&lower.as_str()) || joined.as_deref().is_some_and(|j| ARCH.contains(&j)) {
            break;
        }
        let v = p.strip_prefix(['v', 'V']).unwrap_or(p);
        if v.starts_with(|c: char| c.is_ascii_digit()) && v.contains('.') && !name_parts.is_empty()
        {
            version = v.to_string();
            break;
        }
        name_parts.push(p);
        i += 1;
    }
    let name = if name_parts.is_empty() {
        stem.to_string()
    } else {
        name_parts.join(" ")
    };
    (name, version)
}

#[cfg(target_os = "linux")]
impl AppScanner {
    /// Linux 系统应用枚举：遍历 [`Self::linux_desktop_dirs`] 下 `*.desktop` 转
    /// `ScannedRawApp`（`Name=`→display_name，`X-AppImage-Version=`→display_version，
    /// `Exec` 解析落盘→install_location，文件名→registry_key）；版本缺失时按所属
    /// dpkg/rpm 包反查上游版本；另补 `~/Applications`、`~/AppImages` 下的裸 AppImage。
    pub fn scan_linux_desktop() -> Vec<super::ScannedRawApp> {
        use std::collections::HashSet;
        let mut out: Vec<super::ScannedRawApp> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // 单次扫描内复用同一目录列表（跨调用不缓存，桌面文件随用户操作变动）。
        for dir in Self::linux_desktop_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file()
                    || p.extension()
                        .is_none_or(|e| !e.eq_ignore_ascii_case("desktop"))
                {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&p) else {
                    continue;
                };
                let stem = p
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let Some(parsed) = parse_desktop_entry_content(&stem, &content) else {
                    continue;
                };
                // Exec/TryExec 落盘解析（flatpak 包装器已在 parse 层拒识）。
                let install_location = parsed
                    .exec_bin
                    .as_deref()
                    .and_then(Self::resolve_binary_via_path)
                    .or_else(|| {
                        parsed
                            .try_exec
                            .as_deref()
                            .and_then(Self::resolve_binary_via_path)
                    });
                let dedup_key = format!(
                    "{}::{}",
                    parsed.name.to_lowercase(),
                    install_location.clone().unwrap_or_default().to_lowercase()
                );
                if !seen.insert(dedup_key) {
                    continue;
                }
                // Icon 仅保留绝对路径形态（图标主题名不充当可执行路径）。
                let display_icon = match parsed.icon {
                    Some(ic) if ic.starts_with('/') => Some(ic),
                    _ => install_location.clone(),
                };
                out.push(super::ScannedRawApp {
                    display_name: parsed.name,
                    display_version: parsed.version,
                    install_location,
                    display_icon,
                    registry_key: Some(stem),
                    source_kind: Some(SourceKind::Desktop),
                    ..Default::default()
                });
            }
        }
        Self::fill_linux_package_versions(&mut out);
        Self::append_loose_appimages(&mut out);
        out
    }

    /// 版本缺失且主程序位于系统目录的条目，按所属 dpkg（或 rpm）包反查上游版本。
    fn fill_linux_package_versions(apps: &mut [super::ScannedRawApp]) {
        use std::process::Command;
        const MAX_BATCH: usize = 256;
        let pending: Vec<usize> = apps
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                a.display_version.trim().is_empty()
                    && a.install_location.as_deref().is_some_and(|l| {
                        l.starts_with("/usr/") || l.starts_with("/bin/") || l.starts_with("/opt/")
                    })
            })
            .map(|(i, _)| i)
            .take(MAX_BATCH)
            .collect();
        if pending.is_empty() {
            return;
        }
        let paths: Vec<String> = pending
            .iter()
            .filter_map(|&i| apps[i].install_location.clone())
            .collect();

        if let Ok(search) = Command::new("dpkg-query").arg("-S").args(&paths).output() {
            let owners = parse_dpkg_search_output(&String::from_utf8_lossy(&search.stdout));
            let mut pkgs: Vec<String> = owners.values().cloned().collect();
            pkgs.sort();
            pkgs.dedup();
            if !pkgs.is_empty() {
                if let Ok(listed) = Command::new("dpkg-query")
                    .arg("-W")
                    .arg("-f=${Package}\t${Version}\n")
                    .args(&pkgs)
                    .output()
                {
                    let versions = parse_dpkg_versions(&String::from_utf8_lossy(&listed.stdout));
                    for &i in &pending {
                        let ver = apps[i]
                            .install_location
                            .as_ref()
                            .and_then(|l| owners.get(l))
                            .and_then(|pkg| versions.get(pkg));
                        if let Some(v) = ver {
                            apps[i].display_version = clean_distro_package_version(v);
                        }
                    }
                }
            }
            return;
        }

        for &i in &pending {
            let Some(path) = apps[i].install_location.clone() else {
                continue;
            };
            if let Ok(o) = Command::new("rpm")
                .args(["-qf", "--qf", "%{VERSION}\n"])
                .arg(&path)
                .output()
            {
                let v = String::from_utf8_lossy(&o.stdout);
                let v = v.lines().next().unwrap_or("").trim();
                if o.status.success() && !v.is_empty() && !v.contains(' ') {
                    apps[i].display_version = clean_distro_package_version(v);
                }
            }
        }
    }

    /// `~/Applications`、`~/AppImages` 下尚未被 `.desktop` 覆盖的 `*.AppImage`。
    fn append_loose_appimages(out: &mut Vec<super::ScannedRawApp>) {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        for dir in ["Applications", "AppImages"] {
            let Ok(entries) = std::fs::read_dir(PathBuf::from(&home).join(dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file()
                    || !p
                        .extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("appimage"))
                {
                    continue;
                }
                let path_str = p.to_string_lossy().to_string();
                if out
                    .iter()
                    .any(|a| a.install_location.as_deref() == Some(path_str.as_str()))
                {
                    continue;
                }
                let stem = p.file_stem().unwrap_or_default().to_string_lossy();
                let (name, version) = parse_appimage_stem(&stem);
                out.push(super::ScannedRawApp {
                    display_name: name,
                    display_version: version,
                    install_location: Some(path_str.clone()),
                    display_icon: Some(path_str.clone()),
                    installed_at: Self::detect_path_installed_at(&path_str),
                    source_kind: Some(SourceKind::Appimage),
                    ..Default::default()
                });
            }
        }
    }
}
