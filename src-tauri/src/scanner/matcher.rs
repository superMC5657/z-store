//! 存量应用匹配引擎：构建倒排索引对系统应用召回候选并打分，按分数一对一指派。

use super::types::{
    is_installer_asset_identifier, ConfidenceTier, MatchReason, MIN_QUALIFIED_SCORE,
};
use super::version::same_version;
use super::{AppMatchResult, AppScanner, ScannedRawApp};
use crate::github::CatalogItem;
use std::collections::{HashMap, HashSet};

/// 原生主程序 / 应用包标识精确命中（精校标识）
pub const SCORE_CURATED_EXECUTABLE: f32 = 0.48;
/// 通用文件名的主程序命中，或 repo 派生主程序命中
pub const SCORE_WEAK_EXECUTABLE: f32 = 0.30;
/// 归一化名称精确相等（名称不短于 4 个字符，CJK 不短于 2 个字符）
pub const SCORE_EXACT_NAME_MATCH: f32 = 0.55;
/// 短名精确相等：单靠名称达不到及格线，须有其他信号佐证
pub const SCORE_SHORT_NAME_MATCH: f32 = 0.38;
/// 词元边界前缀
pub const SCORE_PREFIX_NAME_MATCH: f32 = 0.42;
/// 完整词元序列出现在名称中段
pub const SCORE_CONTAINS_NAME_MATCH: f32 = 0.32;
/// 安全别名精确相等
pub const SCORE_ALIAS_MATCH: f32 = 0.38;
/// 安装目录段命中（主程序未命中时）
pub const SCORE_INSTALL_DIR_MATCH: f32 = 0.22;
/// 安装目录段命中（主程序已命中时的叠加）
pub const SCORE_INSTALL_DIR_WITH_EXE: f32 = 0.10;
/// 发布者 / 组织一致
pub const SCORE_PUBLISHER_MATCH: f32 = 0.22;
/// 非平凡版本号一致
pub const SCORE_VERSION_MATCH: f32 = 0.05;
/// 收录项是某上游的衍生版（Fork），而本机证据里没有它的变体词
pub const PENALTY_VARIANT_MISMATCH: f32 = 0.35;

/// 别名里的闭源竞品名：商店搜索用它把用户引到开源替代品，但它不是该应用本身。
const PROPRIETARY_COMPETITOR_BLOCKLIST: &[&str] = &[
    "anydesk",
    "teamviewer",
    "1password",
    "lastpass",
    "bitwarden",
    "postman",
    "insomnia",
    "alfred",
    "raycast",
    "spotlight",
    "bartender",
    "airdrop",
    "evernote",
    "notion",
    "roam",
    "obsidian",
    "acrobat",
    "photoshop",
    "illustrator",
    "premiere",
    "final cut",
    "vmware",
    "parallels",
    "winrar",
    "bandizip",
    "xshell",
    "securecrt",
    "navicat",
    "datagrip",
    "charles",
    "fiddler",
    "surge",
    "docker",
    "epic",
    "steam",
    "gog",
    "discord",
    "slack",
    "firefox",
    "chrome",
    "google chrome",
    "edge",
    "vscode",
    "visual studio code",
    "typora",
    "xmind",
    "sublime text",
];

/// 品类泛词：描述"是什么"而非"叫什么"，不作身份别名。
const ALIAS_GENERIC_STOP_WORDS: &[&str] = &[
    "ide",
    "git",
    "ssh",
    "sftp",
    "api",
    "rest",
    "graphql",
    "http",
    "json",
    "sql",
    "pdf",
    "epub",
    "mp4",
    "mkv",
    "bt",
    "p2p",
    "torrent",
    "proxy",
    "vpn",
    "ocr",
    "tts",
    "ai",
    "llm",
    "cli",
    "tui",
    "gtk",
    "qt",
    "rust",
    "golang",
    "python",
    "electron",
    "tauri",
    "linux",
    "macos",
    "windows",
    "android",
    "ios",
    "browser",
    "浏览器",
    "编辑器",
    "播放器",
    "终端",
    "截图",
    "截屏",
    "录屏",
    "笔记",
    "下载器",
    "下载工具",
    "密码管理",
    "解压缩",
    "压缩软件",
    "模拟器",
    "启动器",
    "工具箱",
    "远程桌面",
];

/// 通用主程序文件名：命中只算弱证据。
const GENERIC_EXE_STEMS: &[&str] = &[
    "app", "main", "client", "desktop", "launcher", "player", "editor", "studio", "terminal",
    "code", "server", "cli",
];

/// 发布者里的组织后缀噪声词。
const PUBLISHER_NOISE: &[&str] = &[
    "inc",
    "llc",
    "ltd",
    "gmbh",
    "corp",
    "corporation",
    "foundation",
    "project",
    "team",
    "studio",
    "software",
    "the",
    "co",
    "dev",
    "developers",
    "contributors",
    "org",
];

/// 衍生版变体词，及本机证据中视为同义的词元（整词比较）。
const VARIANT_QUALIFIERS: &[(&str, &[&str])] = &[
    ("zstd", &["zstd", "zstandard", "zs"]),
    ("zstandard", &["zstd", "zstandard", "zs"]),
    ("rev", &["rev"]),
    ("nyanpasu", &["nyanpasu"]),
    ("next", &["next"]),
    ("codium", &["codium"]),
    ("fork", &["fork"]),
    ("patched", &["patched"]),
    ("reborn", &["reborn"]),
    ("ng", &["ng"]),
];

/// 版本号仅为占位值时不作佐证。
const TRIVIAL_VERSIONS: &[&str] = &["1.0", "1.0.0", "0.1", "0.1.0", "0.0.1"];

/// 拆分词元：空白与 `- _ / \ . : ( ) [ ] ,` 均为分隔符。
pub fn tokenize_words(s: &str) -> Vec<String> {
    s.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '-' | '_' | '/' | '\\' | '.' | ':' | '(' | ')' | '[' | ']' | ','
            )
    })
    .filter(|t| !t.is_empty())
    .map(str::to_lowercase)
    .collect()
}

/// 版本号词元：`v?数字(.数字)+`，可带 `-` / `+` 后缀。
fn is_version_token(t: &str) -> bool {
    let t = t.strip_prefix('v').unwrap_or(t);
    let core_end = t.find(['-', '+']).unwrap_or(t.len());
    let (core, suffix) = t.split_at(core_end);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix
            .chars()
            .skip(1)
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 架构 / 位数词元。
fn is_arch_token(t: &str) -> bool {
    matches!(
        t,
        "x64" | "x86" | "64-bit" | "32-bit" | "win64" | "win32" | "arm64" | "aarch64" | "amd64"
    )
}

/// 括号内的架构 / 安装作用域 / 语言 / 版本标注。
fn is_meta_paren(inner: &str) -> bool {
    let words: Vec<&str> = inner
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    !words.is_empty()
        && words.iter().all(|w| {
            is_arch_token(w)
                || is_version_token(w)
                || matches!(
                    *w,
                    "user" | "machine" | "all" | "users" | "system" | "msi" | "64" | "32" | "bit"
                )
                || is_locale_token(w)
        })
}

/// 语言区域词元：`zh-cn`、`en-us`、`zh-hans`。
fn is_locale_token(w: &str) -> bool {
    match w.split_once('-') {
        Some((a, b)) => {
            a.len() == 2
                && (2..=4).contains(&b.len())
                && a.chars().all(|c| c.is_ascii_lowercase())
                && b.chars().all(|c| c.is_ascii_lowercase())
        }
        None => false,
    }
}

/// 本机显示名归一化：小写；去尾随的架构/作用域/语言/版本括号标注、架构词与版本号。
pub fn normalize_app_title(raw: &str) -> String {
    let mut s = raw
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    loop {
        let before = s.clone();
        if s.ends_with(')') {
            if let Some(open) = s.rfind('(') {
                if is_meta_paren(&s[open + 1..s.len() - 1]) {
                    s = s[..open].trim_end().to_string();
                }
            }
        }
        if let Some((head, last)) = s.rsplit_once(' ') {
            if is_arch_token(last) || is_version_token(last) {
                s = head.trim_end().to_string();
            }
        }
        if s == before {
            break;
        }
    }
    s
}

/// 比较键：词元以空格连接。
fn token_key(s: &str) -> String {
    tokenize_words(s).join(" ")
}

/// 紧凑键：词元直接连接（`VS Code` 与 `vscode` 等同）。
fn compact_key(s: &str) -> String {
    tokenize_words(s).concat()
}

fn is_cjk(c: char) -> bool {
    ('\u{2E80}'..='\u{9FFF}').contains(&c) || ('\u{AC00}'..='\u{D7AF}').contains(&c)
}

/// 名称是否足够长，可单凭精确相等计常规分。
fn is_long_name(compact: &str) -> bool {
    let n = compact.chars().count();
    if compact.chars().any(is_cjk) {
        n >= 2
    } else {
        n >= 4
    }
}

/// 发布者归一化词元（去组织后缀噪声词）。
fn publisher_tokens(s: &str) -> Vec<String> {
    tokenize_words(s)
        .into_iter()
        .filter(|t| !PUBLISHER_NOISE.contains(&t.as_str()))
        .collect()
}

/// 主程序词干：小写、去 `.exe` / `.app`。
fn exe_stem(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".app"))
        .unwrap_or(&lower)
        .to_string()
}

/// 路径段：按 `/`、`\` 切分并做文件名归一化（小写、去空格 `-` `_`）。
fn path_segments(path: &str) -> Vec<String> {
    path.split(['/', '\\'])
        .map(AppScanner::normalize_fs_token)
        .filter(|s| !s.is_empty())
        .collect()
}

/// 路径最后一段（文件名）。
fn last_segment(path: &str) -> Option<&str> {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
}

/// `description_en` 为简短产品标题（1–4 个词、不长于 36 个字符、无句读）时返回其比较键。
fn concise_title(desc: &str) -> Option<String> {
    let d = desc.trim();
    let words = d.split_whitespace().count();
    let sentence_like =
        d.contains(['.', ',', ':', '—']) || d.contains("- ") || d.chars().count() > 36;
    ((1..=4).contains(&words) && !sentence_like).then(|| token_key(d))
}

/// `tokens` 是否以 `prefix` 开头（整词元比较）。
fn starts_with_tokens(tokens: &[String], prefix: &[String]) -> bool {
    !prefix.is_empty() && tokens.len() > prefix.len() && tokens[..prefix.len()] == *prefix
}

/// `needle` 是否作为完整多词元序列（至少 2 个词）出现在 `tokens` 中段（不含开头）。
fn contains_tokens_inside(tokens: &[String], needle: &[String]) -> bool {
    needle.len() >= 2
        && tokens.len() > needle.len()
        && tokens.windows(needle.len()).skip(1).any(|w| w == needle)
}

/// 预归一化的收录条目。
struct IndexedEntry<'a> {
    cat: &'a CatalogItem,
    /// 名称、repo、简短英文标题的比较键与紧凑键
    exact_keys: Vec<String>,
    exact_compacts: Vec<String>,
    /// 名称与 repo 的词元序列（前缀 / 中段序列比较用）
    name_token_seqs: Vec<Vec<String>>,
    safe_alias_compacts: Vec<String>,
    curated_exe_stems: Vec<String>,
    repo_exe_stems: Vec<String>,
    /// 各平台标识（Android 包名、Linux desktop 名等）的小写形态
    bundle_ids: Vec<String>,
    dir_segments: Vec<String>,
    owner_tokens: Vec<String>,
    publisher_seqs: Vec<Vec<String>>,
    variant_markers: Vec<&'static [&'static str]>,
}

/// 收录库的内存倒排索引：每次扫描构建一次。
pub struct CatalogMatchIndex<'a> {
    entries: Vec<IndexedEntry<'a>>,
    by_token: HashMap<String, Vec<usize>>,
    by_exe_stem: HashMap<String, Vec<usize>>,
    by_dir_seg: HashMap<String, Vec<usize>>,
    by_publisher: HashMap<String, Vec<usize>>,
}

/// 单个候选对的打分结果。
#[derive(Debug, Clone)]
struct PairScore {
    score: f32,
    has_curated_exe: bool,
    has_exact_name: bool,
    name_len: usize,
    reasons: Vec<MatchReason>,
}

/// 本机条目的预归一化形态。
struct ScannedView {
    title_key: String,
    title_tokens: Vec<String>,
    title_compact: String,
    key_token_key: Option<String>,
    key_compact: Option<String>,
    key_lower: Option<String>,
    exe_stems: Vec<String>,
    dir_segments: Vec<String>,
    publisher_tokens: Vec<String>,
    /// 名称、包标识、安装路径与图标路径的全部词元（变体词佐证用）
    evidence_tokens: HashSet<String>,
}

impl ScannedView {
    fn new(s: &ScannedRawApp) -> Self {
        let title = normalize_app_title(&s.display_name);
        let title_tokens = tokenize_words(&title);
        let icon = s
            .display_icon
            .as_deref()
            .and_then(AppScanner::clean_display_icon)
            .map(|p| p.to_string_lossy().to_string());
        let loc = s
            .install_location
            .as_deref()
            .map(|l| l.trim().trim_matches('"').to_string())
            .filter(|l| !l.is_empty());

        let mut exe_stems: Vec<String> = Vec::new();
        if let Some(name) = icon.as_deref().and_then(last_segment) {
            exe_stems.push(exe_stem(name));
        }
        if let Some(l) = loc.as_deref() {
            let is_file_path = l.to_lowercase().ends_with(".exe") || l.starts_with('/');
            if is_file_path {
                if let Some(name) = last_segment(l) {
                    exe_stems.push(exe_stem(name));
                }
            }
        }
        exe_stems.dedup();

        let mut dir_segments: Vec<String> = Vec::new();
        for path in [loc.as_deref(), icon.as_deref()].into_iter().flatten() {
            let mut segs = path_segments(path);
            // DisplayIcon 与文件形态的安装路径最后一段是文件名，不算目录段
            if Some(path) == icon.as_deref() || path.to_lowercase().ends_with(".exe") {
                segs.pop();
            }
            for seg in segs {
                if !dir_segments.contains(&seg) {
                    dir_segments.push(seg);
                }
            }
        }

        let publisher_tokens = s
            .publisher
            .as_deref()
            .map(publisher_tokens)
            .unwrap_or_default();
        let key_lower = s
            .registry_key
            .as_deref()
            .map(|k| k.trim().to_lowercase())
            .filter(|k| !k.is_empty());
        let evidence_tokens: HashSet<String> = [
            Some(title.as_str()),
            key_lower.as_deref(),
            loc.as_deref(),
            icon.as_deref(),
        ]
        .into_iter()
        .flatten()
        .flat_map(tokenize_words)
        .collect();

        Self {
            title_key: title_tokens.join(" "),
            title_compact: title_tokens.concat(),
            title_tokens,
            key_token_key: key_lower
                .as_deref()
                .map(token_key)
                .filter(|k| !k.is_empty()),
            key_compact: key_lower
                .as_deref()
                .map(compact_key)
                .filter(|k| !k.is_empty()),
            key_lower,
            exe_stems,
            dir_segments,
            publisher_tokens,
            evidence_tokens,
        }
    }
}

impl<'a> IndexedEntry<'a> {
    /// `primary_owners`：全库名称/repo 紧凑键 → 所属条目下标（判定别名是否为其他收录项的名字）。
    fn new(
        cat: &'a CatalogItem,
        idx: usize,
        primary_owners: &HashMap<String, Vec<usize>>,
        platform: &str,
    ) -> Self {
        let name_key = token_key(&normalize_app_title(&cat.name));
        let repo_key = token_key(&cat.repo);
        let mut exact_keys = vec![name_key.clone(), repo_key.clone()];
        if let Some(title) = cat.description_en.as_deref().and_then(concise_title) {
            exact_keys.push(title);
        }
        exact_keys.retain(|k| !k.is_empty());
        exact_keys.dedup();
        let exact_compacts: Vec<String> = exact_keys.iter().map(|k| k.replace(' ', "")).collect();

        let own_names: HashSet<String> = [compact_key(&cat.name), compact_key(&cat.repo)]
            .into_iter()
            .collect();
        let safe_alias_compacts = cat
            .aliases
            .iter()
            .filter_map(|a| {
                let lower = a.trim().to_lowercase();
                let compact = compact_key(&lower);
                let n = lower.chars().count();
                let too_short = if lower.chars().any(is_cjk) {
                    n < 2
                } else {
                    n < 3
                };
                let competitor = PROPRIETARY_COMPETITOR_BLOCKLIST.contains(&lower.as_str())
                    && !own_names.contains(&compact);
                let blocked = too_short
                    || competitor
                    || primary_owners
                        .get(&compact)
                        .is_some_and(|owners| owners.iter().any(|&o| o != idx))
                    || lower.contains("替代")
                    || lower.contains("alternative")
                    || ALIAS_GENERIC_STOP_WORDS.contains(&lower.as_str())
                    || super::executable::CANDIDATE_STOP_WORDS.contains(&lower.as_str());
                (!blocked && !compact.is_empty()).then_some(compact)
            })
            .collect();

        let mut curated_exe_stems: Vec<String> = cat
            .get_identifiers_for_platform(platform)
            .into_iter()
            .filter(|id| !is_installer_asset_identifier(id, &cat.repo, &cat.name))
            .map(|id| exe_stem(&id))
            .filter(|s| !s.is_empty())
            .collect();
        curated_exe_stems.dedup();
        let repo_lower = cat.repo.to_lowercase();
        let mut repo_exe_stems = Vec::new();
        if repo_lower.chars().count() >= 4 {
            repo_exe_stems.push(repo_lower.clone());
            let compact = repo_lower.replace(['-', '.', '_'], "");
            if compact != repo_lower {
                repo_exe_stems.push(compact);
            }
        }

        let bundle_ids: Vec<String> = cat
            .identifiers
            .values()
            .flatten()
            .map(|id| exe_stem(id))
            .filter(|id| id.contains('.') || id.chars().count() >= 4)
            .collect();

        let mut dir_segments: Vec<String> = cat
            .install_dirs
            .iter()
            .flat_map(|d| path_segments(d))
            .chain(std::iter::once(AppScanner::normalize_fs_token(&cat.repo)))
            .filter(|s| s.chars().count() >= 4)
            .collect();
        dir_segments.sort();
        dir_segments.dedup();

        let mut name_token_seqs = vec![tokenize_words(&name_key), tokenize_words(&repo_key)];
        name_token_seqs.retain(|s| !s.is_empty());
        name_token_seqs.dedup();

        let catalog_tokens: Vec<String> = name_token_seqs.iter().flatten().cloned().collect();
        let variant_markers = VARIANT_QUALIFIERS
            .iter()
            .filter(|(q, _)| catalog_tokens.iter().any(|t| t == q))
            .map(|(_, markers)| *markers)
            .collect();

        Self {
            cat,
            exact_keys,
            exact_compacts,
            name_token_seqs,
            safe_alias_compacts,
            curated_exe_stems,
            repo_exe_stems,
            bundle_ids,
            dir_segments,
            owner_tokens: publisher_tokens(&cat.owner),
            publisher_seqs: cat
                .publishers
                .iter()
                .map(|p| publisher_tokens(p))
                .filter(|p| !p.is_empty())
                .collect(),
            variant_markers,
        }
    }

    /// 名称维度：(分值, 依据, 匹配到的名称长度, 是否精确)。
    fn name_score(
        &self,
        view: &ScannedView,
        stripped: Option<&[String]>,
    ) -> (f32, Option<MatchReason>, usize, bool) {
        let stripped_pair = stripped.map(|t| (t.join(" "), t.concat()));
        let candidates = std::iter::once((view.title_key.as_str(), view.title_compact.as_str()))
            .chain(
                stripped_pair
                    .as_ref()
                    .map(|(k, c)| (k.as_str(), c.as_str())),
            )
            .chain(
                view.key_token_key
                    .as_deref()
                    .zip(view.key_compact.as_deref()),
            );

        for (key, compact) in candidates {
            if key.is_empty() {
                continue;
            }
            let hit = self.exact_keys.iter().any(|k| k == key)
                || self.exact_compacts.iter().any(|c| c == compact);
            if hit {
                let len = compact.chars().count();
                let score = if is_long_name(compact) {
                    SCORE_EXACT_NAME_MATCH
                } else {
                    SCORE_SHORT_NAME_MATCH
                };
                return (score, Some(MatchReason::ExactName), len, true);
            }
        }

        let mut best: (f32, usize) = (0.0, 0);
        for s_tokens in std::iter::once(view.title_tokens.as_slice()).chain(stripped) {
            for c_tokens in self.name_token_seqs.iter().map(Vec::as_slice) {
                let (shorter, prefix_hit) = if starts_with_tokens(s_tokens, c_tokens) {
                    (c_tokens, true)
                } else if starts_with_tokens(c_tokens, s_tokens) {
                    (s_tokens, true)
                } else if contains_tokens_inside(s_tokens, c_tokens) {
                    (c_tokens, false)
                } else {
                    continue;
                };
                let phrase_len = shorter.join(" ").chars().count();
                let score = if prefix_hit && phrase_len >= 4 {
                    SCORE_PREFIX_NAME_MATCH
                } else if !prefix_hit && phrase_len >= 5 {
                    SCORE_CONTAINS_NAME_MATCH
                } else {
                    continue;
                };
                if score > best.0 {
                    best = (score, phrase_len);
                }
            }
        }
        if best.0 > 0.0 {
            return (best.0, Some(MatchReason::PrefixName), best.1, false);
        }

        if self.safe_alias_compacts.iter().any(|a| {
            *a == view.title_compact || stripped_pair.as_ref().is_some_and(|(_, c)| a == c)
        }) {
            return (
                SCORE_ALIAS_MATCH,
                Some(MatchReason::Alias),
                view.title_compact.chars().count(),
                false,
            );
        }
        (0.0, None, 0, false)
    }

    /// 主程序 / 应用包标识维度：(分值, 依据, 是否精校主程序命中)。
    fn executable_score(&self, view: &ScannedView) -> (f32, Option<MatchReason>, bool) {
        let generic = |s: &str| GENERIC_EXE_STEMS.contains(&s);
        let mut best: (f32, Option<MatchReason>, bool) = (0.0, None, false);
        let mut consider = |score: f32, reason: MatchReason, curated: bool| {
            if score > best.0 {
                best = (score, Some(reason), curated);
            }
        };
        for stem in &view.exe_stems {
            if self.curated_exe_stems.contains(stem) {
                if generic(stem) {
                    consider(SCORE_WEAK_EXECUTABLE, MatchReason::Executable, false);
                } else {
                    consider(SCORE_CURATED_EXECUTABLE, MatchReason::Executable, true);
                }
            } else if self.repo_exe_stems.contains(stem) && !generic(stem) {
                consider(SCORE_WEAK_EXECUTABLE, MatchReason::Executable, false);
            }
        }
        if let Some(key) = view.key_lower.as_deref() {
            if (key.contains('.') || key.chars().count() >= 4)
                && !generic(key)
                && self.bundle_ids.iter().any(|b| b == key)
            {
                consider(SCORE_CURATED_EXECUTABLE, MatchReason::BundleId, true);
            }
        }
        best
    }

    fn install_dir_hit(&self, view: &ScannedView) -> bool {
        view.dir_segments
            .iter()
            .any(|seg| self.dir_segments.contains(seg))
    }

    fn publisher_hit(&self, view: &ScannedView) -> bool {
        let s = &view.publisher_tokens;
        if s.is_empty() {
            return false;
        }
        let owner_hit = !self.owner_tokens.is_empty()
            && (s.concat() == self.owner_tokens.concat()
                || (self.owner_tokens.len() == 1
                    && self.owner_tokens[0].chars().count() >= 3
                    && s.contains(&self.owner_tokens[0])));
        owner_hit
            || self.publisher_seqs.iter().any(|p| {
                s == p
                    || (p.concat().chars().count() >= 3
                        && s.windows(p.len()).any(|w| w == p.as_slice()))
            })
    }

    /// 收录项带变体词，而本机名称、包标识与路径的词元里都没有。
    /// 本机证据中出现收录项的紧凑全名（`NotepadNext.exe`）也算带上了变体词。
    fn variant_mismatch(&self, view: &ScannedView) -> bool {
        if self.variant_markers.is_empty()
            || view
                .evidence_tokens
                .iter()
                .any(|t| self.exact_compacts.contains(t))
        {
            return false;
        }
        self.variant_markers
            .iter()
            .any(|markers| !markers.iter().any(|m| view.evidence_tokens.contains(*m)))
    }

    fn score(&self, view: &ScannedView, scanned: &ScannedRawApp) -> PairScore {
        // 名称首词为条目所有者或发布者时，额外比较剥离厂商前缀后的名称。
        let vendor = view.title_tokens.first();
        let stripped = (view.title_tokens.len() > 1
            && vendor.is_some_and(|v| {
                *v == self.owner_tokens.concat()
                    || self.publisher_seqs.iter().any(|p| p.first() == Some(v))
            }))
        .then(|| &view.title_tokens[1..]);

        let mut reasons: Vec<MatchReason> = Vec::new();
        let (exe_score, exe_reason, curated) = self.executable_score(view);
        let (name_score, name_reason, name_len, exact) = self.name_score(view, stripped);
        let dir_hit = self.install_dir_hit(view);
        let bundle_hit = exe_reason == Some(MatchReason::BundleId);
        let mut publisher = self.publisher_hit(view);

        let mut exe_score = exe_score;
        let mut curated = curated;
        let mut score = name_score;
        if let Some(r) = name_reason {
            reasons.push(r);
        }
        if self.variant_mismatch(view) {
            // 衍生版与上游共用主程序名与发布者，这两项不能证明本机装的是衍生版
            if !(dir_hit || bundle_hit) {
                exe_score = 0.0;
                curated = false;
                publisher = false;
            }
            score -= PENALTY_VARIANT_MISMATCH;
        }
        if exe_score > 0.0 {
            score += exe_score;
            if let Some(r) = exe_reason {
                reasons.push(r);
            }
        }
        if dir_hit {
            score += if exe_score > 0.0 {
                SCORE_INSTALL_DIR_WITH_EXE
            } else {
                SCORE_INSTALL_DIR_MATCH
            };
            reasons.push(MatchReason::InstallDir);
        }
        if publisher {
            score += SCORE_PUBLISHER_MATCH;
            reasons.push(MatchReason::Publisher);
        }
        if (name_score > 0.0 || exe_score > 0.0) && !scanned.display_version.trim().is_empty() {
            let v = scanned.display_version.trim();
            let bare = v.strip_prefix(['v', 'V']).unwrap_or(v);
            if same_version(v, &self.cat.default_version) && !TRIVIAL_VERSIONS.contains(&bare) {
                score += SCORE_VERSION_MATCH;
                reasons.push(MatchReason::Version);
            }
        }

        PairScore {
            score: score.clamp(0.0, 1.0),
            has_curated_exe: curated,
            has_exact_name: exact,
            name_len,
            reasons,
        }
    }
}

fn push_bucket(map: &mut HashMap<String, Vec<usize>>, key: String, idx: usize) {
    if key.is_empty() {
        return;
    }
    let bucket = map.entry(key).or_default();
    if bucket.last() != Some(&idx) {
        bucket.push(idx);
    }
}

impl<'a> CatalogMatchIndex<'a> {
    /// 预归一化条目并建立四路倒排桶（使用当前编译目标平台的主程序标识）。
    pub fn build(catalog: impl IntoIterator<Item = &'a CatalogItem>) -> Self {
        Self::build_for_platform(catalog, CatalogItem::current_platform_key())
    }

    /// 按指定平台键（`windows` / `linux` / `macos`）的原生主程序标识构建倒排索引。
    pub fn build_for_platform(
        catalog: impl IntoIterator<Item = &'a CatalogItem>,
        platform: &str,
    ) -> Self {
        let items: Vec<&CatalogItem> = catalog.into_iter().collect();
        let mut primary_owners: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, c) in items.iter().enumerate() {
            for key in [compact_key(&c.name), compact_key(&c.repo)] {
                push_bucket(&mut primary_owners, key, idx);
            }
        }
        let mut by_token = HashMap::new();
        let mut by_exe_stem = HashMap::new();
        let mut by_dir_seg = HashMap::new();
        let mut by_publisher = HashMap::new();
        let mut entries = Vec::with_capacity(items.len());

        for (idx, cat) in items.iter().enumerate() {
            let entry = IndexedEntry::new(cat, idx, &primary_owners, platform);

            for seq in &entry.name_token_seqs {
                for t in seq {
                    push_bucket(&mut by_token, t.clone(), idx);
                }
            }
            for k in entry.exact_keys.iter() {
                for t in k.split(' ') {
                    push_bucket(&mut by_token, t.to_string(), idx);
                }
            }
            for c in entry
                .exact_compacts
                .iter()
                .chain(&entry.safe_alias_compacts)
            {
                push_bucket(&mut by_token, c.clone(), idx);
            }
            for s in entry
                .curated_exe_stems
                .iter()
                .chain(&entry.repo_exe_stems)
                .chain(&entry.bundle_ids)
            {
                push_bucket(&mut by_exe_stem, s.clone(), idx);
            }
            for d in &entry.dir_segments {
                push_bucket(&mut by_dir_seg, d.clone(), idx);
            }
            for t in entry
                .owner_tokens
                .iter()
                .chain(entry.publisher_seqs.iter().flatten())
            {
                push_bucket(&mut by_publisher, t.clone(), idx);
            }
            entries.push(entry);
        }

        Self {
            entries,
            by_token,
            by_exe_stem,
            by_dir_seg,
            by_publisher,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 经倒排桶召回的候选条目下标（升序、去重）。
    fn candidates(&self, view: &ScannedView, seen: &mut [u32], stamp: u32) -> Vec<usize> {
        let mut out = Vec::new();
        let mut take = |bucket: Option<&Vec<usize>>| {
            for &i in bucket.into_iter().flatten() {
                if seen[i] != stamp {
                    seen[i] = stamp;
                    out.push(i);
                }
            }
        };
        for t in &view.title_tokens {
            take(self.by_token.get(t));
        }
        take(self.by_token.get(&view.title_compact));
        if let Some(k) = &view.key_compact {
            take(self.by_token.get(k));
            for t in tokenize_words(k) {
                take(self.by_token.get(&t));
            }
        }
        if let Some(k) = &view.key_lower {
            take(self.by_exe_stem.get(k));
        }
        for s in &view.exe_stems {
            take(self.by_exe_stem.get(s));
        }
        for d in &view.dir_segments {
            take(self.by_dir_seg.get(d));
        }
        for p in &view.publisher_tokens {
            take(self.by_publisher.get(p));
        }
        out.sort_unstable();
        out
    }

    /// 本机条目 `scanned` 被召回的候选收录项 id（测试与诊断用）。
    pub fn candidate_ids(&self, scanned: &ScannedRawApp) -> Vec<&str> {
        let mut seen = vec![0u32; self.entries.len()];
        self.candidates(&ScannedView::new(scanned), &mut seen, 1)
            .into_iter()
            .map(|i| self.entries[i].cat.id.as_str())
            .collect()
    }
}

/// 一对一指派结果（纯打分，不触盘）。
pub struct Assignment<'a> {
    pub scanned_index: usize,
    pub catalog: &'a CatalogItem,
    score: PairScore,
}

impl Assignment<'_> {
    pub fn confidence(&self) -> f32 {
        self.score.score
    }

    pub fn reasons(&self) -> &[MatchReason] {
        &self.score.reasons
    }
}

impl<'a> CatalogMatchIndex<'a> {
    /// 对全部本机条目召回候选并打分，再按 (分数, 精校主程序, 精确名称, 名称长度) 全局降序
    /// 贪心一对一指派；同分按输入顺序决定，结果与收录库顺序无关。
    pub fn assign(&self, scanned_apps: &[ScannedRawApp]) -> Vec<Assignment<'a>> {
        let mut qualified: Vec<QualifiedPair> = Vec::new();
        let mut seen = vec![0u32; self.len()];
        for (s_idx, scanned) in scanned_apps.iter().enumerate() {
            let view = ScannedView::new(scanned);
            let stamp = s_idx as u32 + 1;
            for c_idx in self.candidates(&view, &mut seen, stamp) {
                let pair = self.entries[c_idx].score(&view, scanned);
                if pair.score >= MIN_QUALIFIED_SCORE {
                    qualified.push(QualifiedPair { s_idx, c_idx, pair });
                }
            }
        }

        qualified.sort_by(|a, b| {
            b.pair
                .score
                .total_cmp(&a.pair.score)
                .then(b.pair.has_curated_exe.cmp(&a.pair.has_curated_exe))
                .then(b.pair.has_exact_name.cmp(&a.pair.has_exact_name))
                .then(b.pair.name_len.cmp(&a.pair.name_len))
                .then(a.s_idx.cmp(&b.s_idx))
                .then(
                    self.entries[a.c_idx]
                        .cat
                        .id
                        .cmp(&self.entries[b.c_idx].cat.id),
                )
        });

        let mut used_scanned = vec![false; scanned_apps.len()];
        let mut used_cat = vec![false; self.len()];
        let mut out = Vec::new();
        for q in qualified {
            if used_scanned[q.s_idx] || used_cat[q.c_idx] {
                continue;
            }
            used_scanned[q.s_idx] = true;
            used_cat[q.c_idx] = true;
            out.push(Assignment {
                scanned_index: q.s_idx,
                catalog: self.entries[q.c_idx].cat,
                score: q.pair,
            });
        }
        out
    }
}

/// 全局一对一指派前的合格候选对。
struct QualifiedPair {
    s_idx: usize,
    c_idx: usize,
    pair: PairScore,
}

impl AppScanner {
    /// 将已扫描的应用与收录库匹配打分，返回一对一指派后的结果（按置信度降序）。
    pub fn match_apps(
        scanned_apps: &[ScannedRawApp],
        catalog: &[CatalogItem],
    ) -> Vec<AppMatchResult> {
        Self::match_with_index(scanned_apps, &CatalogMatchIndex::build(catalog))
    }

    fn match_with_index(
        scanned_apps: &[ScannedRawApp],
        index: &CatalogMatchIndex<'_>,
    ) -> Vec<AppMatchResult> {
        index
            .assign(scanned_apps)
            .into_iter()
            .map(|a| Self::build_result(&scanned_apps[a.scanned_index], a.catalog, a.score))
            .collect()
    }

    fn build_result(scanned: &ScannedRawApp, cat: &CatalogItem, pair: PairScore) -> AppMatchResult {
        let confidence = pair.score;
        let tier = ConfidenceTier::from_score(confidence);

        let resolved_exe = Self::resolve_executable_path(
            scanned.install_location.as_deref(),
            scanned.display_icon.as_deref(),
            cat,
        );
        // 版本未知时留空，绝不以收录库最新版冒充（否则永远检测不到更新）
        let local_version = Self::detect_local_version(
            &scanned.display_version,
            resolved_exe.as_deref(),
            Self::read_exe_version,
        )
        .unwrap_or_default();

        let mut scanned_entry = scanned.clone();
        if scanned_entry.installed_at.is_none() {
            scanned_entry.installed_at = resolved_exe
                .as_deref()
                .and_then(Self::detect_path_installed_at)
                .or_else(|| {
                    scanned_entry
                        .install_location
                        .as_deref()
                        .and_then(Self::detect_path_installed_at)
                });
        }

        AppMatchResult {
            scanned: scanned_entry,
            catalog_id: cat.id.clone(),
            name: cat.name.clone(),
            owner: cat.owner.clone(),
            repo: cat.repo.clone(),
            icon: cat.icon.clone(),
            icon_bg: cat.icon_bg.clone(),
            description: cat.description.clone(),
            local_version,
            catalog_version: cat.default_version.clone(),
            confidence,
            confidence_tier: tier,
            resolved_executable_path: resolved_exe,
            match_reasons: pair.reasons,
        }
    }

    /// 剔除已纳管应用（id 经规范化比较）与不支持当前平台的收录项后再匹配。
    pub fn match_unmanaged(
        scanned_apps: &[ScannedRawApp],
        catalog: &[CatalogItem],
        installed_ids: impl IntoIterator<Item = String>,
    ) -> Vec<AppMatchResult> {
        let managed: HashSet<String> = installed_ids
            .into_iter()
            .map(|id| crate::forge::canonical_lookup_id(&id))
            .filter(|k| !k.is_empty())
            .collect();
        let platform = CatalogItem::current_platform_key();
        let eligible = catalog.iter().filter(|cat| {
            !managed.contains(&crate::forge::canonical_lookup_id(&cat.id))
                && (cat.platforms.is_empty()
                    || cat
                        .platforms
                        .iter()
                        .any(|p| p.eq_ignore_ascii_case(platform)))
        });
        Self::match_with_index(scanned_apps, &CatalogMatchIndex::build(eligible))
    }
}
