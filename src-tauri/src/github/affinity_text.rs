//! 推荐画像的文本底座：中英双语分词、目录级 IDF 与词边界分类推断。

use super::models::CatalogItem;
use crate::models::AppSummary;
use std::collections::{HashMap, HashSet};

/// 是否为 10 个标准分类之一（调用方负责小写化）。
pub fn is_standard_category(key: &str) -> bool {
    crate::db::custom_apps::OFFICIAL_CATEGORIES.contains(&key)
}

/// 长度不足 3 但有区分度的技术词。
const SHORT_TECH_TOKENS: &[&str] = &[
    "ai", "ui", "2d", "3d", "db", "os", "vm", "go", "qt", "ip", "ci", "cd", "md", "tv",
];

/// 英文停用词：虚词、平台名与开源项目描述里的泛化套话。
const ASCII_STOPWORDS: &[&str] = &[
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "these",
    "those",
    "into",
    "onto",
    "via",
    "also",
    "any",
    "all",
    "are",
    "was",
    "were",
    "been",
    "being",
    "has",
    "have",
    "had",
    "not",
    "can",
    "will",
    "just",
    "only",
    "own",
    "our",
    "out",
    "over",
    "under",
    "about",
    "than",
    "then",
    "them",
    "they",
    "their",
    "there",
    "very",
    "you",
    "your",
    "yours",
    "its",
    "who",
    "what",
    "which",
    "when",
    "where",
    "while",
    "why",
    "how",
    "more",
    "most",
    "much",
    "many",
    "some",
    "such",
    "other",
    "each",
    "every",
    "etc",
    "one",
    "new",
    "best",
    "easy",
    "like",
    "way",
    "use",
    "used",
    "uses",
    "using",
    "make",
    "makes",
    "made",
    "allows",
    "allow",
    "lets",
    "get",
    "gets",
    "app",
    "apps",
    "application",
    "applications",
    "software",
    "program",
    "programs",
    "tool",
    "tools",
    "utility",
    "open",
    "source",
    "opensource",
    "free",
    "cross",
    "platform",
    "platforms",
    "multi",
    "multiplatform",
    "windows",
    "linux",
    "macos",
    "mac",
    "android",
    "ios",
    "desktop",
    "client",
    "server",
    "based",
    "written",
    "fast",
    "faster",
    "modern",
    "simple",
    "lightweight",
    "powerful",
    "built",
    "support",
    "supports",
    "supported",
    "official",
    "repository",
    "repo",
    "project",
    "projects",
    "github",
    "gitlab",
    "codeberg",
    "code",
    "http",
    "https",
    "www",
    "com",
    "org",
    "net",
    "io",
    "version",
    "release",
    "releases",
    "feature",
    "features",
    "full",
    "featured",
    "alternative",
    "fully",
    "highly",
    "high",
    "performance",
    "native",
    "small",
    "great",
    "better",
    "awesome",
    "community",
    "mirror",
    "read",
    "mirrored",
    "home",
    "page",
    "welcome",
    "users",
    "user",
    "help",
    "provides",
    "providing",
    "designed",
    "focused",
    "available",
    "including",
    "includes",
    "first",
    "next",
    "gen",
    "generation",
];

/// 中文泛化双字词。
const CJK_STOP_BIGRAMS: &[&str] = &[
    "开源", "软件", "工具", "应用", "支持", "平台", "跨平", "客户", "户端", "免费", "一个", "基于",
    "管理", "系统", "器与", "的跨", "程序", "项目", "功能", "使用", "提供", "可以", "简单", "强大",
    "轻量", "现代", "全平", "多平", "官方", "替代",
];

/// 含有这些功能字的中文双字片段多为跨词拼接，不作为词元。
const CJK_FUNCTION_CHARS: &[char] = &[
    '的', '了', '和', '与', '及', '或', '是', '在', '为', '等', '也', '让', '将', '把', '被', '并',
    '更', '最', '从', '之', '其', '你', '我', '它', '这', '那', '个', '款', '用',
];

fn is_cjk(c: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&c)
}

fn strip_url_in_chunk(chunk: &str) -> &str {
    let bytes = chunk.as_bytes();
    for i in 0..bytes.len() {
        let rest = &bytes[i..];
        if (rest.len() >= 7 && rest[..7].eq_ignore_ascii_case(b"http://"))
            || (rest.len() >= 8 && rest[..8].eq_ignore_ascii_case(b"https://"))
        {
            return &chunk[..i];
        }
    }
    chunk
}

/// 去掉 `http://` / `https://` 起始的 URL 片段（到下一个空白为止）。
fn strip_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, chunk) in text.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(strip_url_in_chunk(chunk));
    }
    out
}

fn keep_ascii_token(tok: &str) -> bool {
    if tok.is_empty() || tok.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if tok.len() < 3 && !SHORT_TECH_TOKENS.contains(&tok) {
        return false;
    }
    !ASCII_STOPWORDS.contains(&tok)
}

/// 连续汉字里不参与双字滑窗的位置。功能字与泛化双字词（自左向右贪心匹配）都充当分隔，
/// 避免在它们两侧拼出跨词碎片（如「开源的跨平台工具」不产出「台工」）。
fn cjk_blocked(run: &[char]) -> Vec<bool> {
    let mut blocked = vec![false; run.len()];
    let mut i = 0;
    while i < run.len() {
        if CJK_FUNCTION_CHARS.contains(&run[i]) {
            blocked[i] = true;
            i += 1;
            continue;
        }
        if i + 1 < run.len() && !CJK_FUNCTION_CHARS.contains(&run[i + 1]) {
            let pair: String = run[i..i + 2].iter().collect();
            if CJK_STOP_BIGRAMS.contains(&pair.as_str()) {
                blocked[i] = true;
                blocked[i + 1] = true;
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    blocked
}

/// 连续汉字的双字滑窗（分隔规则见 [`cjk_blocked`]），按首次出现去重写入 `out`。
fn push_cjk_bigrams(run: &[char], out: &mut Vec<String>, seen: &mut HashSet<String>) {
    for chain in cjk_run_chains(run) {
        for bigram in chain {
            if seen.insert(bigram.clone()) {
                out.push(bigram);
            }
        }
    }
}

/// 一段连续汉字切出的双字词元链：链内相邻两项首尾相接（`编程` → `程智` → `智能`），
/// 遇到分隔位置断开成新链。不去重。
fn cjk_run_chains(run: &[char]) -> Vec<Vec<String>> {
    let blocked = cjk_blocked(run);
    let mut chains: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for start in 0..run.len().saturating_sub(1) {
        if blocked[start] || blocked[start + 1] {
            if !current.is_empty() {
                chains.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(run[start..start + 2].iter().collect());
    }
    if !current.is_empty() {
        chains.push(current);
    }
    chains
}

/// 各段文本里所有连续汉字的双字词元链（见 [`cjk_run_chains`]），按出现顺序排列、不去重；
/// 切分口径与 [`extract_tokens_from_parts`] 一致。
pub fn cjk_bigram_chains_from_parts<'a>(
    parts: impl IntoIterator<Item = &'a str>,
) -> Vec<Vec<String>> {
    let mut chains = Vec::new();
    let mut run: Vec<char> = Vec::new();
    for part in parts {
        for chunk in part.split_whitespace() {
            for c in strip_url_in_chunk(chunk).chars() {
                if is_cjk(c) {
                    run.push(c);
                } else if !run.is_empty() {
                    chains.extend(cjk_run_chains(&run));
                    run.clear();
                }
            }
            if !run.is_empty() {
                chains.extend(cjk_run_chains(&run));
                run.clear();
            }
        }
    }
    chains
}

fn flush_ascii(buf: &mut String, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    if buf.is_empty() {
        return;
    }
    let tok = buf.trim_start_matches('+').to_ascii_lowercase();
    buf.clear();
    if keep_ascii_token(&tok) && seen.insert(tok.clone()) {
        out.push(tok);
    }
}

fn feed_chunk_tokens(
    chunk: &str,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
    ascii: &mut String,
    cjk: &mut Vec<char>,
) {
    for c in strip_url_in_chunk(chunk).chars() {
        if c.is_ascii_alphanumeric() || c == '+' {
            if !cjk.is_empty() {
                push_cjk_bigrams(cjk, out, seen);
                cjk.clear();
            }
            ascii.push(c);
        } else if is_cjk(c) {
            flush_ascii(ascii, out, seen);
            cjk.push(c);
        } else {
            flush_ascii(ascii, out, seen);
            if !cjk.is_empty() {
                push_cjk_bigrams(cjk, out, seen);
                cjk.clear();
            }
        }
    }
    flush_ascii(ascii, out, seen);
    if !cjk.is_empty() {
        push_cjk_bigrams(cjk, out, seen);
        cjk.clear();
    }
}

/// 分段提取去重词元（等价于以空格拼接各段后再调用 `extract_tokens`，但不分配拼接串）。
pub fn extract_tokens_from_parts<'a>(parts: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();

    for part in parts {
        for chunk in part.split_whitespace() {
            feed_chunk_tokens(chunk, &mut out, &mut seen, &mut ascii, &mut cjk);
        }
    }
    out
}

/// 中英双语分词：剥离 URL；英文按非字母数字切分（保留词内 `+`，如 `c++`），
/// 长度 ≥ 3 或命中短技术词白名单，过滤停用词与纯数字；连续汉字按双字滑窗切分并过滤泛化词。
/// 结果按首次出现顺序去重。
pub fn extract_tokens(text: &str) -> Vec<String> {
    extract_tokens_from_parts(std::iter::once(text))
}

/// 应用参与分词的文本段，按名称、仓库、别名、中文简介、英文简介的顺序。
fn app_parts<'a>(
    name: &'a str,
    repo: &'a str,
    description: &'a str,
    description_en: Option<&'a str>,
    aliases: &'a [String],
) -> impl Iterator<Item = &'a str> {
    [name, repo]
        .into_iter()
        .chain(aliases.iter().map(String::as_str))
        .chain([description, description_en.unwrap_or("")])
}

/// 分段提取应用词元（名称、仓库、别名与中英简介），避免无谓的文本拼接分配。
pub fn extract_app_tokens(
    name: &str,
    repo: &str,
    description: &str,
    description_en: Option<&str>,
    aliases: &[String],
) -> Vec<String> {
    extract_tokens_from_parts(app_parts(name, repo, description, description_en, aliases))
}

/// 提取目录条目的词元（含别名）。
pub fn extract_catalog_item_tokens(item: &CatalogItem) -> Vec<String> {
    extract_app_tokens(
        &item.name,
        &item.repo,
        &item.description,
        item.description_en.as_deref(),
        &item.aliases,
    )
}

/// 提取精选候选的词元。
pub fn extract_summary_tokens(app: &AppSummary, aliases: &[String]) -> Vec<String> {
    extract_app_tokens(
        &app.core.name,
        &app.core.repo,
        &app.core.description,
        app.core.description_en.as_deref(),
        aliases,
    )
}

/// 精选候选全文（同 [`extract_summary_tokens`] 的文本段）里的汉字双字词元链。
pub fn summary_cjk_chains(app: &AppSummary, aliases: &[String]) -> Vec<Vec<String>> {
    cjk_bigram_chains_from_parts(app_parts(
        &app.core.name,
        &app.core.repo,
        &app.core.description,
        app.core.description_en.as_deref(),
        aliases,
    ))
}

/// 应用参与画像词袋、IDF 与相似度计算的文本：名称、仓库、别名与中英简介。
/// 目录条目、精选候选与未收录应用概要都经此拼接，保证分词口径一致。
pub fn app_text(
    name: &str,
    repo: &str,
    description: &str,
    description_en: Option<&str>,
    aliases: &[String],
) -> String {
    format!(
        "{} {} {} {} {}",
        name,
        repo,
        aliases.join(" "),
        description,
        description_en.unwrap_or("")
    )
}

/// 目录条目的 `app_text`（含别名，IDF 的文档单位）。
pub fn catalog_item_text(item: &CatalogItem) -> String {
    app_text(
        &item.name,
        &item.repo,
        &item.description,
        item.description_en.as_deref(),
        &item.aliases,
    )
}

/// 精选候选的 `app_text`；`AppSummary` 不带别名，需要时由调用方从目录查出传入。
pub fn summary_text(app: &AppSummary, aliases: &[String]) -> String {
    app_text(
        &app.core.name,
        &app.core.repo,
        &app.core.description,
        app.core.description_en.as_deref(),
        aliases,
    )
}

/// 目录级逆文档频率：区分泛化词与领域专有词。
#[derive(Debug, Clone, Default)]
pub struct CatalogIdf {
    docs: usize,
    df: HashMap<String, usize>,
}

impl CatalogIdf {
    pub fn from_catalog(items: &[CatalogItem]) -> Self {
        Self::from_catalog_iter(items.iter())
    }

    pub fn from_catalog_iter<'a>(items: impl IntoIterator<Item = &'a CatalogItem>) -> Self {
        let mut docs = 0usize;
        let mut df: HashMap<String, usize> = HashMap::new();
        for item in items {
            docs += 1;
            for tok in extract_catalog_item_tokens(item) {
                *df.entry(tok).or_insert(0) += 1;
            }
        }
        Self { docs, df }
    }

    /// 每条文本视为一个文档。
    pub fn from_texts<I, S>(texts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut docs = 0usize;
        let mut df: HashMap<String, usize> = HashMap::new();
        for text in texts {
            docs += 1;
            for tok in extract_tokens(text.as_ref()) {
                *df.entry(tok).or_insert(0) += 1;
            }
        }
        Self { docs, df }
    }

    /// 归一化 IDF：`clamp(ln((N+1)/(df+1)) / ln(N+1), 0.15, 1.0)`；
    /// 空目录或目录中未出现的词返回 `1.0`。
    pub fn weight(&self, token: &str) -> f64 {
        if self.docs == 0 {
            return 1.0;
        }
        let df = self.df.get(token).copied().unwrap_or(0);
        if df == 0 {
            return 1.0;
        }
        let n = self.docs as f64;
        (((n + 1.0) / (df as f64 + 1.0)).ln() / (n + 1.0).ln()).clamp(0.15, 1.0)
    }

    /// 两个词元集合按 IDF 加权的余弦相似度，范围 `[0, 1]`；任一为空返回 `0`。
    pub fn cosine_similarity(&self, a_tokens: &[String], b_tokens: &[String]) -> f64 {
        let a: HashSet<&str> = a_tokens.iter().map(String::as_str).collect();
        let b: HashSet<&str> = b_tokens.iter().map(String::as_str).collect();
        if a.is_empty() || b.is_empty() {
            return 0.0;
        }
        let norm = |set: &HashSet<&str>| -> f64 {
            set.iter()
                .map(|t| self.weight(t).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let dot: f64 = a.intersection(&b).map(|t| self.weight(t).powi(2)).sum();
        let denom = norm(&a) * norm(&b);
        if denom <= 1e-12 {
            return 0.0;
        }
        (dot / denom).clamp(0.0, 1.0)
    }
}

/// 分类推断规则：整词关键词、按词边界匹配的英文短语、中文子串关键词。
struct CategoryRule {
    category: &'static str,
    words: &'static [&'static str],
    phrases: &'static [&'static str],
    cjk: &'static [&'static str],
}

const CATEGORY_RULES: &[CategoryRule] = &[
    CategoryRule {
        category: "media",
        words: &[
            "video",
            "audio",
            "music",
            "player",
            "media",
            "ffmpeg",
            "mpv",
            "vlc",
            "stream",
            "streaming",
            "podcast",
            "codec",
            "subtitle",
            "danmaku",
            "iptv",
            "spotify",
            "lyric",
            "lyrics",
            "recorder",
            "youtube",
            "bilibili",
            "movie",
            "anime",
            "radio",
            "song",
            "playback",
            "jellyfin",
            "plex",
            "kodi",
            "obs",
            "mp3",
            "flac",
            "transcoder",
            "dlna",
            "netease",
            "soundcloud",
            "tv",
        ],
        phrases: &["screen recording", "live streaming", "media server"],
        cjk: &[
            "音视频",
            "播放器",
            "音乐",
            "视频",
            "直播",
            "字幕",
            "录音",
            "录屏",
            "影音",
            "弹幕",
            "番剧",
            "歌词",
            "电视",
            "听歌",
        ],
    },
    CategoryRule {
        category: "security",
        words: &[
            "security",
            "password",
            "crypto",
            "encrypt",
            "encryption",
            "encrypted",
            "cipher",
            "vault",
            "2fa",
            "totp",
            "otp",
            "authenticator",
            "privacy",
            "firewall",
            "keepass",
            "keepassxc",
            "bitwarden",
            "gpg",
            "pgp",
            "audit",
            "malware",
            "antivirus",
            "secure",
            "secret",
            "veracrypt",
            "kdbx",
            "pentest",
            "sniffer",
            "forensic",
            "yubikey",
        ],
        phrases: &["password manager", "two factor", "packet analyzer"],
        cjk: &[
            "密码",
            "加密",
            "隐私",
            "安全",
            "验证器",
            "两步验证",
            "杀毒",
            "防火墙",
        ],
    },
    CategoryRule {
        category: "network",
        words: &[
            "network",
            "networking",
            "proxy",
            "proxies",
            "vpn",
            "tunnel",
            "dns",
            "clash",
            "v2ray",
            "xray",
            "trojan",
            "wireguard",
            "torrent",
            "bittorrent",
            "aria2",
            "download",
            "downloader",
            "transfer",
            "localsend",
            "packet",
            "socks5",
            "shadowsocks",
            "wifi",
            "lan",
            "p2p",
            "airdrop",
            "router",
            "mihomo",
            "singbox",
            "hysteria",
            "browser",
            "chromium",
            "firefox",
            "webkit",
            "messaging",
            "messenger",
            "chat",
            "telegram",
            "matrix",
            "irc",
            "email",
            "mail",
            "ftp",
            "sync",
            "syncthing",
            "share",
            "sharing",
        ],
        phrases: &[
            "sing box",
            "file transfer",
            "file sharing",
            "web browser",
            "download manager",
        ],
        cjk: &[
            "代理",
            "下载",
            "传输",
            "网络",
            "磁力",
            "内网穿透",
            "局域网",
            "翻墙",
            "科学上网",
            "浏览器",
            "聊天",
        ],
    },
    CategoryRule {
        category: "ops",
        words: &[
            "docker",
            "kubernetes",
            "k8s",
            "container",
            "devops",
            "monitoring",
            "prometheus",
            "grafana",
            "ansible",
            "terraform",
            "nginx",
            "redis",
            "postgres",
            "postgresql",
            "mysql",
            "mariadb",
            "sqlite",
            "mongodb",
            "sql",
            "database",
            "ssh",
            "sftp",
            "cluster",
            "infra",
            "infrastructure",
            "homelab",
            "deploy",
            "deployment",
            "k3s",
            "helm",
            "podman",
            "vagrant",
            "qemu",
            "virtualbox",
            "hypervisor",
            "vm",
            "virtualization",
            "kubectl",
            "rdp",
            "vnc",
            "telnet",
            "serial",
            "dbeaver",
        ],
        phrases: &[
            "virtual machine",
            "sql client",
            "database manager",
            "ssh client",
        ],
        cjk: &[
            "运维",
            "容器",
            "服务器",
            "监控",
            "数据库",
            "部署",
            "集群",
            "虚拟机",
        ],
    },
    CategoryRule {
        category: "graphics",
        words: &[
            "image",
            "photo",
            "photography",
            "graphics",
            "draw",
            "drawing",
            "paint",
            "painting",
            "canvas",
            "blender",
            "3d",
            "svg",
            "vector",
            "shader",
            "gimp",
            "krita",
            "inkscape",
            "screenshot",
            "ocr",
            "color",
            "colour",
            "pixel",
            "sprite",
            "illustration",
            "modeling",
            "modeler",
            "modeller",
            "cad",
            "render",
            "renderer",
            "gif",
            "icon",
            "raw",
            "viewer",
            "figma",
            "designer",
            "animation",
            "diagram",
            "whiteboard",
            "picture",
        ],
        phrases: &["image viewer", "photo editor", "pixel art", "ui design"],
        cjk: &[
            "图像", "画图", "设计", "截图", "修图", "建模", "绘图", "图片", "照片", "白板",
        ],
    },
    CategoryRule {
        category: "office",
        words: &[
            "note",
            "markdown",
            "knowledge",
            "obsidian",
            "logseq",
            "notion",
            "pdf",
            "document",
            "office",
            "spreadsheet",
            "todo",
            "task",
            "calendar",
            "pomodoro",
            "latex",
            "typst",
            "wiki",
            "writing",
            "writer",
            "mindmap",
            "presentation",
            "excel",
            "productivity",
            "outline",
            "outliner",
            "journal",
            "diary",
            "workspace",
            "zettelkasten",
            "notepad",
            "kanban",
            "invoice",
            "accounting",
            "finance",
            "budget",
        ],
        phrases: &[
            "note taking",
            "mind map",
            "knowledge base",
            "time tracking",
            "word processor",
        ],
        cjk: &[
            "笔记",
            "文档",
            "办公",
            "待办",
            "思维导图",
            "日历",
            "写作",
            "效率",
            "知识库",
        ],
    },
    CategoryRule {
        category: "reading",
        words: &[
            "ebook",
            "epub",
            "reader",
            "rss",
            "feed",
            "book",
            "calibre",
            "novel",
            "manga",
            "comic",
            "dictionary",
            "translate",
            "translation",
            "translator",
            "anki",
            "flashcard",
            "kindle",
            "reading",
            "atom",
            "citation",
            "research",
            "djvu",
            "mobi",
            "audiobook",
            "newsreader",
        ],
        phrases: &["feed reader", "rss reader", "e book", "e books"],
        cjk: &[
            "阅读",
            "电子书",
            "漫画",
            "翻译",
            "词典",
            "订阅",
            "小说",
            "背单词",
        ],
    },
    CategoryRule {
        category: "games",
        words: &[
            "game",
            "gaming",
            "emulator",
            "emulation",
            "retro",
            "arcade",
            "minecraft",
            "steam",
            "godot",
            "unity",
            "unreal",
            "voxel",
            "puzzle",
            "chess",
            "nintendo",
            "playstation",
            "xbox",
            "gamepad",
            "controller",
            "rom",
            "roms",
            "rpg",
            "rts",
            "strategy",
            "simulation",
            "simulator",
            "multiplayer",
            "shooter",
            "platformer",
            "libretro",
            "gameboy",
            "psp",
            "3ds",
            "wii",
            "gamecube",
            "dos",
            "doom",
            "quake",
        ],
        phrases: &["game boy", "game engine", "tower defense"],
        cjk: &["游戏", "模拟器", "联机"],
    },
    CategoryRule {
        category: "system",
        words: &[
            "remote",
            "rustdesk",
            "window",
            "launcher",
            "explorer",
            "cleaner",
            "uninstaller",
            "disk",
            "partition",
            "archive",
            "archiver",
            "zip",
            "7zip",
            "rar",
            "driver",
            "hotkey",
            "autohotkey",
            "powertoys",
            "taskbar",
            "tray",
            "startup",
            "registry",
            "backup",
            "clipboard",
            "keyboard",
            "mouse",
            "battery",
            "brightness",
            "wallpaper",
            "debloat",
            "tweak",
            "tweaker",
            "customization",
            "thumbnail",
            "thumbnails",
            "dock",
            "widget",
            "widgets",
            "usb",
            "bootable",
            "iso",
            "uninstall",
            "installer",
            "screensaver",
            "everything",
            "search",
            "file",
            "files",
            "folder",
            "folders",
            "hardware",
            "cpu",
            "gpu",
            "temperature",
            "fan",
            "teamviewer",
            "anydesk",
        ],
        phrases: &[
            "file manager",
            "remote desktop",
            "system monitor",
            "window manager",
            "system tray",
            "package manager",
            "task manager",
        ],
        cjk: &[
            "远程桌面",
            "桌面",
            "系统",
            "清理",
            "压缩",
            "启动器",
            "文件管理",
            "卸载",
            "备份",
            "驱动",
            "快捷键",
            "任务栏",
            "剪贴板",
            "右键",
        ],
    },
    CategoryRule {
        category: "dev",
        words: &[
            "editor",
            "ide",
            "terminal",
            "shell",
            "git",
            "compiler",
            "debugger",
            "sdk",
            "framework",
            "library",
            "cli",
            "neovim",
            "vim",
            "vscode",
            "zed",
            "api",
            "json",
            "regex",
            "developer",
            "developers",
            "programming",
            "devtools",
            "postman",
            "lsp",
            "linter",
            "formatter",
            "debug",
            "graphql",
            "rest",
            "jupyter",
            "repl",
            "prompt",
            "emacs",
            "grep",
            "diff",
            "merge",
            "hex",
            "decompiler",
            "disassembler",
            "reverse",
            "http",
            "websocket",
            "grpc",
            "mock",
            "cmake",
            "toolchain",
            "notebook",
            "gitignore",
        ],
        phrases: &[
            "code editor",
            "text editor",
            "terminal emulator",
            "source control",
            "version control",
            "api client",
            "http client",
            "visual studio",
        ],
        cjk: &["开发", "開發", "终端", "编辑器", "代码", "编程"],
    },
];

/// 小写英文整词集合（按非字母数字切分，保留 `+`），附带简单复数还原（`players` → `player`）。
fn word_set(text: &str) -> (HashSet<String>, String) {
    let mut words: Vec<String> = Vec::new();
    for raw in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '+')) {
        let w = raw.trim_matches('+').to_ascii_lowercase();
        if !w.is_empty() {
            words.push(w);
        }
    }
    let joined = format!(" {} ", words.join(" "));
    let mut set: HashSet<String> = HashSet::with_capacity(words.len() * 2);
    for w in words {
        if w.len() > 3 {
            if let Some(stem) = w.strip_suffix("ies") {
                set.insert(format!("{stem}y"));
            } else if let Some(stem) = w.strip_suffix('s') {
                if !stem.ends_with('s') {
                    set.insert(stem.to_string());
                }
            }
        }
        set.insert(w);
    }
    (set, joined)
}

/// 将仓库按 `language`、`description` 与 `full_name` 映射到标准分类，返回
/// `(category, confidence)` 按置信度降序。英文关键词按整词匹配，短语按词边界匹配，
/// 中文关键词按子串匹配；只有高区分度的领域语言才提供语言提示。
pub fn infer_categories(
    language: &str,
    description: &str,
    full_name: &str,
) -> Vec<(&'static str, f64)> {
    let lang = language.trim().to_ascii_lowercase();
    // 语言名只走下方的领域语言提示，不参与关键词匹配（`Shell`、`Vim Script` 不应命中 dev 的 `shell`、`vim`）
    let text = format!("{} {}", full_name, description);
    let lower = text.to_lowercase();
    let (words, joined) = word_set(&strip_urls(&text));

    let mut matched: Vec<(&'static str, f64, usize)> = Vec::new();
    for (order, rule) in CATEGORY_RULES.iter().enumerate() {
        let hits = rule.words.iter().filter(|w| words.contains(**w)).count()
            + rule
                .phrases
                .iter()
                .filter(|p| joined.contains(&format!(" {p} ")))
                .count()
            + rule.cjk.iter().filter(|k| lower.contains(**k)).count();
        if hits > 0 {
            let weight = (0.55 + (hits.saturating_sub(1) as f64) * 0.2).min(1.0);
            matched.push((rule.category, weight, order));
        }
    }

    let lang_hint: Option<(&'static str, f64)> = match lang.as_str() {
        "hcl" | "dockerfile" | "nix" | "shell" | "bash" | "powershell" => Some(("ops", 0.5)),
        "shaderlab" | "glsl" | "hlsl" | "wgsl" => Some(("graphics", 0.6)),
        "gdscript" => Some(("games", 0.85)),
        "tex" | "typst" => Some(("office", 0.65)),
        _ => None,
    };
    if let Some((cat, w)) = lang_hint {
        if !matched.iter().any(|(c, _, _)| *c == cat) {
            matched.push((cat, w, CATEGORY_RULES.len()));
        }
    }

    matched.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.2.cmp(&b.2))
    });
    matched.into_iter().map(|(c, w, _)| (c, w)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<String> {
        extract_tokens(s)
    }

    #[test]
    fn extract_drops_generic_words_urls_and_splits_hyphens() {
        let t = toks("An open-source cross-platform desktop app https://code.videolan.org/vlc");
        for bad in [
            "open-source",
            "cross-platform",
            "desktop",
            "https",
            "open",
            "source",
            "vlc",
        ] {
            assert!(!t.contains(&bad.to_string()), "{bad} in {t:?}");
        }
    }

    #[test]
    fn extract_keeps_short_tech_words_and_cpp() {
        assert_eq!(toks("3d ai ui tool"), vec!["3d", "ai", "ui"]);
        assert_eq!(toks("C++ IDE, 2024"), vec!["c++", "ide"]);
    }

    #[test]
    fn extract_produces_cjk_bigrams() {
        let t = toks("远程桌面视频播放器");
        for want in ["远程", "桌面", "视频", "播放"] {
            assert!(t.contains(&want.to_string()), "{want} missing in {t:?}");
        }
        let t2 = toks("开源的跨平台工具");
        assert!(t2.is_empty(), "{t2:?}");
    }

    #[test]
    fn extract_dedupes_in_first_seen_order() {
        assert_eq!(toks("video Video player video"), vec!["video", "player"]);
    }

    fn sample_idf() -> CatalogIdf {
        CatalogIdf::from_texts([
            "mpv video player",
            "code editor",
            "markdown editor",
            "hex editor",
            "image editor",
            "rich text editor",
        ])
    }

    #[test]
    fn idf_rewards_rare_tokens() {
        let idf = sample_idf();
        assert!(idf.weight("mpv") > idf.weight("editor"));
        assert!((idf.weight("unknownword") - 1.0).abs() < 1e-12);
        assert!(idf.weight("editor") >= 0.15);
        let empty = CatalogIdf::default();
        assert!((empty.weight("editor") - 1.0).abs() < 1e-12);
    }

    #[test]
    fn cosine_identity_disjoint_and_empty() {
        let idf = sample_idf();
        let a = vec!["mpv".to_string(), "video".to_string()];
        assert!((idf.cosine_similarity(&a, &a) - 1.0).abs() < 1e-9);
        let b = vec!["markdown".to_string()];
        assert_eq!(idf.cosine_similarity(&a, &b), 0.0);
        assert_eq!(idf.cosine_similarity(&a, &[]), 0.0);
        let c = vec!["video".to_string(), "markdown".to_string()];
        let s = idf.cosine_similarity(&a, &c);
        assert!(s > 0.0 && s < 1.0);
    }

    #[test]
    fn infer_uses_word_boundaries() {
        let cats = infer_categories(
            "C++",
            "Command line video client with https://github.com/a/b",
            "org/player",
        );
        assert_eq!(cats.first().map(|c| c.0), Some("media"));
        assert!(!cats.iter().any(|(c, _)| *c == "dev"), "{cats:?}");

        let note = infer_categories("", "A notebook for ideas", "x/y");
        assert!(!note.iter().any(|(c, _)| *c == "reading"), "{note:?}");
    }

    #[test]
    fn infer_uses_language_only_as_domain_hint() {
        assert_eq!(
            infer_categories("Shell", "", "a/dotfiles"),
            vec![("ops", 0.5)]
        );
        assert!(infer_categories("Vim Script", "", "a/b").is_empty());
    }

    #[test]
    fn infer_has_no_language_fallback() {
        assert!(infer_categories("Rust", "", "alice/my-experiment").is_empty());
        assert_eq!(
            infer_categories("GDScript", "", "alice/my-experiment"),
            vec![("games", 0.85)]
        );
    }

    #[test]
    fn infer_matches_phrases_and_cjk() {
        let cats = infer_categories("", "A fast terminal emulator", "a/term");
        assert_eq!(cats[0].0, "dev");
        let cats = infer_categories("", "开源远程桌面", "a/b");
        assert_eq!(cats[0].0, "system");
        let cats = infer_categories("", "using box layouts", "a/b");
        assert!(!cats.iter().any(|(c, _)| *c == "network"), "{cats:?}");
    }

    #[test]
    fn extract_parts_matches_joined_text_tokenization() {
        let aliases = vec!["CodePad".to_string(), "C++".to_string()];
        let name = "MyEditor";
        let repo = "my-editor";
        let desc = "开源编辑器 https://example.com/path 视频播放";
        let desc_en = Some("Fast editor prefixHTTP://ignored and c++");

        let direct = extract_app_tokens(name, repo, desc, desc_en, &aliases);
        let joined = extract_tokens(&app_text(name, repo, desc, desc_en, &aliases));
        assert_eq!(direct, joined);
    }
}
