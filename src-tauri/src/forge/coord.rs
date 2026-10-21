//! Canonical App Id 后端唯一源（ADR-0010）。
//!
//! - 全形态 canonical（小写 `owner/repo` / `forge[:host]:owner/repo`）解析 SSOT 为
//!   `RepositoryUrlParser::parse`；`canonical_app_id` / `canonical_lookup_id` /
//!   `canonical_app_id_from_parts` 皆经它收敛，不另立 normalizer（`icon_key`
//!   事件 key 与 `resolve_icon_coord` DB 主键为其薄委托，三键同值）。
//! - 前端归一单口为 `src/services/normalizeId.ts`（`normalizeId`）；前后端键全同，
//!   大小写漂移行经 canonical 治愈。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeType {
    GitHub,
    Codeberg,
    Gitea,
    GitLab,
}

impl ForgeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::Codeberg => "codeberg",
            Self::Gitea => "gitea",
            Self::GitLab => "gitlab",
        }
    }

    pub fn default_host(&self) -> &'static str {
        match self {
            Self::GitHub => "github.com",
            Self::Codeberg => "codeberg.org",
            Self::Gitea => "gitea.com",
            Self::GitLab => "gitlab.com",
        }
    }

    /// 宿主精确或白名单子域匹配（大小写不敏感）：`github.com` 命中
    /// `api.github.com` / `github.com:443`，不命中 `xx-github.com` / `github.com.evil.com`。
    /// 比较前剥端口（`split(':').next()`，与 `mirror::url_host` 同口径）并去尾部点。
    pub fn matches_host(&self, host: &str) -> bool {
        let host = host.trim().to_lowercase();
        let host = host.split(':').next().unwrap_or("").trim_end_matches('.');
        let domain = self.default_host();
        host == domain || host.ends_with(&format!(".{domain}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UniversalRepoCoord {
    pub forge: ForgeType,
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl UniversalRepoCoord {
    pub fn to_app_id(&self) -> String {
        if self.forge == ForgeType::GitHub && self.host == "github.com" {
            format!("{}/{}", self.owner, self.repo)
        } else if self.host == self.forge.default_host() {
            format!("{}:{}/{}", self.forge.as_str(), self.owner, self.repo)
        } else {
            format!(
                "{}:{}/{}/{}",
                self.forge.as_str(),
                self.host,
                self.owner,
                self.repo
            )
        }
    }
}

/// ADR-0010：入站应用标识归一化为 canonical 形态
/// （小写 `owner/repo`，或带 forge 前缀的 `forge[:host]:owner/repo`）。
/// 支持完整仓库 URL、forge 前缀短语法（含 `gh/cb/gt/gl` 别名）与裸 owner/repo；
/// 无法解析的未知标识返回 `None`，由调用方显式拒绝，不透传脏 id。
pub fn canonical_app_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    RepositoryUrlParser::parse(trimmed).map(|coord| coord.to_app_id().to_lowercase())
}

/// `(owner, repo)` → canonical 唯一真相源。
/// `canonical_app_id`（单串全形态解析）、`icon_key`（事件 id）、
/// `resolve_icon_coord` canonical（DB 主键）三者同值——后两者为本函数的
/// 薄委托；DB 主键/事件 id/前端归一键全同。
/// total 函数永不失败：可解析直取 canonical，不可解析回退小写拼接
///（调用方传入已 trim 干净坐标时恒走解析分支）。
pub fn canonical_app_id_from_parts(owner: &str, repo: &str) -> String {
    let raw = format!("{}/{}", owner.trim(), repo.trim());
    canonical_app_id(&raw).unwrap_or_else(|| raw.to_lowercase())
}

/// 入站键归一（total）：`canonical_app_id` 可解析直取 canonical，
/// 不可解析回退 `trim().to_lowercase()`（与 ADR-0010"原样小写兜底"同形）。
/// 深链解析层与存量 id 比对层用；执行层拒绝语义仍在 `require_app_id`，分层不混淆。
pub fn canonical_lookup_id(raw: &str) -> String {
    let trimmed = raw.trim();
    canonical_app_id(trimmed).unwrap_or_else(|| trimmed.to_lowercase())
}

pub struct RepositoryUrlParser;

/// host 段校验（注入面收口）：拒绝空值与 `?`/`#`/`/`/反斜杠/空白——这些字符
/// 入 URL 路径即路径/查询注入，入 canonical 键即脏键。放行 `:` 以承载自建实例
/// 的非标端口；`/`/`://` 经上游 split 切分天然不出现，此处仍显式拒绝作纵深防御。
fn valid_host_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.contains(['?', '#', '/', '\\'])
        && !s.chars().any(char::is_whitespace)
}

/// owner/repo 段校验：同 host 口径并拒绝 `:`——`owner:repo` 会与
/// `forge:host:owner/repo` 语法混淆。
fn valid_repo_segment(s: &str) -> bool {
    valid_host_segment(s) && !s.contains(':')
}

/// 解析出口唯一构造点：四条解析分支经此校验收敛，脏段一律 `None`。
fn checked_coord(
    forge: ForgeType,
    host: &str,
    owner: &str,
    repo: &str,
) -> Option<UniversalRepoCoord> {
    if !valid_host_segment(host) || !valid_repo_segment(owner) || !valid_repo_segment(repo) {
        return None;
    }
    Some(UniversalRepoCoord {
        forge,
        host: host.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// Web URL 的 host 归一：小写、去尾部点、去默认端口（https 443 / http 80）。
/// 非标端口保留，自建实例 API 仍需带端口访问；canonical 键因此与无端口写法同值。
fn normalize_url_host(raw: &str, is_https: bool) -> String {
    let host = raw.trim().to_lowercase();
    let default_port = if is_https { "443" } else { "80" };
    let host = match host.rsplit_once(':') {
        Some((head, port)) if port == default_port => head.to_string(),
        _ => host,
    };
    host.trim_end_matches('.').to_string()
}

impl RepositoryUrlParser {

    pub fn parse(input: &str) -> Option<UniversalRepoCoord> {
        let s = input.trim();
        if s.is_empty() {
            return None;
        }

        // 1. 解析完整的 Web URL (例如 https://codeberg.org/FreeTube/FreeTube)
        if s.starts_with("http://") || s.starts_with("https://") {
            let is_https = s.starts_with("https://");
            let without_proto = if let Some(rest) = s.strip_prefix("https://") {
                rest
            } else if let Some(rest) = s.strip_prefix("http://") {
                rest
            } else {
                s
            };

            let parts: Vec<&str> = without_proto.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() >= 3 {
                let host = normalize_url_host(parts[0], is_https);
                let owner = parts[1].trim();
                let mut repo_part = parts[2].trim();
                if let Some(pos) = repo_part.find('?') {
                    repo_part = &repo_part[..pos];
                }
                if let Some(pos) = repo_part.find('#') {
                    repo_part = &repo_part[..pos];
                }
                let mut repo = repo_part.to_string();
                if let Some(stripped) = repo.strip_suffix(".git") {
                    repo = stripped.to_string();
                }

                let forge = if ForgeType::GitHub.matches_host(&host) {
                    ForgeType::GitHub
                } else if ForgeType::Codeberg.matches_host(&host) {
                    ForgeType::Codeberg
                } else if ForgeType::GitLab.matches_host(&host) {
                    ForgeType::GitLab
                } else {
                    // 自建域名默认遵循 Gitea / Forgejo REST API 体系
                    ForgeType::Gitea
                };

                return checked_coord(forge, &host, owner, &repo);
            }
        }

        // 2. 解析前缀短语法 (例如 codeberg:FreeTube/FreeTube 或 gitea:git.example.com/owner/repo)
        if let Some((prefix, rest)) = s.split_once(':') {
            let forge_opt = match prefix.to_lowercase().as_str() {
                "codeberg" | "cb" => Some(ForgeType::Codeberg),
                "github" | "gh" => Some(ForgeType::GitHub),
                "gitea" | "gt" => Some(ForgeType::Gitea),
                "gitlab" | "gl" => Some(ForgeType::GitLab),
                _ => None,
            };

            if let Some(forge) = forge_opt {
                let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
                if parts.len() == 2 {
                    let mut repo_part = parts[1].trim();
                    if let Some(pos) = repo_part.find('?') {
                        repo_part = &repo_part[..pos];
                    }
                    if let Some(pos) = repo_part.find('#') {
                        repo_part = &repo_part[..pos];
                    }
                    let mut repo = repo_part.to_string();
                    if let Some(stripped) = repo.strip_suffix(".git") {
                        repo = stripped.to_string();
                    }
                    return checked_coord(forge, forge.default_host(), parts[0].trim(), &repo);
                } else if parts.len() == 3 {
                    let mut repo_part = parts[2].trim();
                    if let Some(pos) = repo_part.find('?') {
                        repo_part = &repo_part[..pos];
                    }
                    if let Some(pos) = repo_part.find('#') {
                        repo_part = &repo_part[..pos];
                    }
                    let mut repo = repo_part.to_string();
                    if let Some(stripped) = repo.strip_suffix(".git") {
                        repo = stripped.to_string();
                    }
                    return checked_coord(forge, parts[0].trim(), parts[1].trim(), &repo);
                }
            }
        }

        // 3. 经典 owner/repo 形式 (默认作为 GitHub 仓库处理)
        if s.contains('/') && !s.contains(' ') && !s.contains(':') {
            let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() == 2 {
                let owner = parts[0].trim().to_string();
                let mut repo_part = parts[1].trim();
                if let Some(pos) = repo_part.find('?') {
                    repo_part = &repo_part[..pos];
                }
                if let Some(pos) = repo_part.find('#') {
                    repo_part = &repo_part[..pos];
                }
                let mut repo = repo_part.to_string();
                if let Some(stripped) = repo.strip_suffix(".git") {
                    repo = stripped.to_string();
                }
                if !owner.is_empty() && !repo.is_empty() {
                    return checked_coord(ForgeType::GitHub, "github.com", &owner, &repo);
                }
            }
        }

        None
    }
}

/// 图标已确认记录的大小写容错查询 SSOT（db 查询侧）。
/// 收拢散落在调用方的 `to_lowercase` 多段回退；解析器本身保持大小写保留、不被污染。
/// 查询顺序：`app_id` 原值 → `canonical_app_id` → 小写 → `owner/repo`（解析器优先）原值 → 小写；
/// `owner/repo` 优先经 `RepositoryUrlParser::parse(app_id)` 推导（SSOT），回退调用方传入值；命中即返。
///
/// 注：同模块不存在可复用的 `ForgeCoord` 类型（仅 `UniversalRepoCoord`，
/// 其 `forge`/`host` 对图标查询是多余维度），故此处引入最小 `RepoRef` 承载
/// `owner`/`repo` 对，大小写归一收敛于 [`RepoRef::lowercased`] 单点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
}

impl RepoRef {
    pub fn new(owner: &str, repo: &str) -> Self {
        Self {
            owner: owner.trim().to_string(),
            repo: repo.trim().to_string(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.owner.is_empty() || self.repo.is_empty()
    }

    /// 唯一的大小写归一落点：`lookup_case_insensitive` 内不手写 `to_lowercase`。
    pub fn lowercased(&self) -> Self {
        Self {
            owner: self.owner.to_lowercase(),
            repo: self.repo.to_lowercase(),
        }
    }
}

/// `app_id` 维度候选键（顺序即查询顺序，去重）：原值 → `canonical_app_id` → 小写。
fn app_id_lookup_keys(app_id: &str) -> Vec<String> {
    let clean_id = app_id.trim();
    if clean_id.is_empty() {
        return Vec::new();
    }
    let mut keys = vec![clean_id.to_string()];
    if let Some(canon) = canonical_app_id(clean_id) {
        if !keys.contains(&canon) {
            keys.push(canon);
        }
    }
    let lower = clean_id.to_lowercase();
    if !keys.contains(&lower) {
        keys.push(lower);
    }
    keys
}

/// `owner/repo` 维度候选键（顺序即查询顺序，去重）：解析器推导原值 → 其小写。
/// 解析器推导为唯一真相源（上游已有 `canonical_app_id` 守卫）。
fn repo_lookup_keys(app_id: &str, fallback: &RepoRef) -> Vec<RepoRef> {
    let clean_id = app_id.trim();
    let eff = match RepositoryUrlParser::parse(clean_id) {
        Some(coord) if !coord.owner.is_empty() && !coord.repo.is_empty() => {
            RepoRef::new(&coord.owner, &coord.repo)
        }
        _ => fallback.clone(),
    };
    let mut keys = Vec::new();
    let push_unique = |r: RepoRef, keys: &mut Vec<RepoRef>| {
        if !r.is_empty() && !keys.contains(&r) {
            keys.push(r);
        }
    };
    push_unique(eff.clone(), &mut keys);
    push_unique(eff.lowercased(), &mut keys);
    keys
}

pub fn lookup_case_insensitive(
    db: &crate::db::Database,
    app_id: &str,
    repo: &RepoRef,
) -> Option<crate::db::AppIconCycle> {
    for key in app_id_lookup_keys(app_id) {
        if let Ok(Some(cycle)) = db.get_icon_cycle(&key) {
            return Some(cycle);
        }
    }

    for r in repo_lookup_keys(app_id, repo) {
        if let Ok(Some(cycle)) = db.get_icon_cycle_by_repo(&r.owner, &r.repo) {
            return Some(cycle);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_app_id_from_parts_is_total_and_canonical() {
        // 常规坐标：解析分支。
        assert_eq!(canonical_app_id_from_parts("rustdesk", "rustdesk"), "rustdesk/rustdesk");
        assert_eq!(
            canonical_app_id_from_parts("SuperMC5657", "Z-Store"),
            "supermc5657/z-store"
        );
        // 前后空白被归一（DB/事件键全同）。
        assert_eq!(canonical_app_id_from_parts("  O  ", "  R  "), "o/r");
        // 不可解析回退小写拼接（total 永不失败）。
        assert_eq!(canonical_app_id_from_parts("", ""), "/");
        assert_eq!(canonical_app_id_from_parts("o", "r r"), "o/r r");
    }

    #[test]
    fn test_three_keys_unified_db_event_keys_identical() {
        // `canonical_app_id` / `icon_key`（事件 id）/
        // `resolve_icon_coord` canonical（DB 主键）全同。
        let joined = canonical_app_id_from_parts("SuperMC5657", "Z-Store");
        assert_eq!(
            crate::forge::canonical_app_id("SuperMC5657/Z-Store").as_deref(),
            Some(joined.as_str())
        );
        assert_eq!(crate::github::icon_fetch::icon_key("SuperMC5657", "Z-Store"), joined);
        assert_eq!(
            crate::db::icon_cycle::resolve_icon_coord("SuperMC5657/Z-Store")
                .unwrap()
                .0,
            joined
        );
    }

    #[test]
    fn test_canonical_lookup_id_parse_or_lowercase_fallback() {
        assert_eq!(canonical_lookup_id("RustDesk/RustDesk"), "rustdesk/rustdesk");
        assert_eq!(
            canonical_lookup_id("https://github.com/RustDesk/RustDesk"),
            "rustdesk/rustdesk"
        );
        assert_eq!(canonical_lookup_id("codeberg:FreeTubeApp/FreeTube"), "codeberg:freetubeapp/freetube");
        // 不可解析回退小写（深链解析层不断路由；执行层 `require_app_id` 再拒绝）。
        assert_eq!(canonical_lookup_id("rustdesk"), "rustdesk");
        assert_eq!(canonical_lookup_id("  "), "");
    }
}
