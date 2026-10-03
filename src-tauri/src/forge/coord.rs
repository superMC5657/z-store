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
/// 无法解析的未知标识返回 `None`，由调用方显式拒绝，不再透传脏 id。
pub fn canonical_app_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    RepositoryUrlParser::parse(trimmed).map(|coord| coord.to_app_id().to_lowercase())
}

pub struct RepositoryUrlParser;

impl RepositoryUrlParser {
    pub fn parse(input: &str) -> Option<UniversalRepoCoord> {
        let s = input.trim();
        if s.is_empty() {
            return None;
        }

        // 1. 解析完整的 Web URL (例如 https://codeberg.org/FreeTube/FreeTube)
        if s.starts_with("http://") || s.starts_with("https://") {
            let without_proto = if let Some(rest) = s.strip_prefix("https://") {
                rest
            } else if let Some(rest) = s.strip_prefix("http://") {
                rest
            } else {
                s
            };

            let parts: Vec<&str> = without_proto.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() >= 3 {
                let host = parts[0].to_lowercase();
                let owner = parts[1].to_string();
                let mut repo_part = parts[2];
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

                let forge = if host.contains("github.com") {
                    ForgeType::GitHub
                } else if host.contains("codeberg.org") {
                    ForgeType::Codeberg
                } else if host.contains("gitlab.com") {
                    ForgeType::GitLab
                } else {
                    // 自建域名默认遵循 Gitea / Forgejo REST API 体系
                    ForgeType::Gitea
                };

                return Some(UniversalRepoCoord {
                    forge,
                    host,
                    owner,
                    repo,
                });
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
                    return Some(UniversalRepoCoord {
                        forge,
                        host: forge.default_host().to_string(),
                        owner: parts[0].trim().to_string(),
                        repo,
                    });
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
                    return Some(UniversalRepoCoord {
                        forge,
                        host: parts[0].trim().to_string(),
                        owner: parts[1].trim().to_string(),
                        repo,
                    });
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
                    return Some(UniversalRepoCoord {
                        forge: ForgeType::GitHub,
                        host: "github.com".to_string(),
                        owner,
                        repo,
                    });
                }
            }
        }

        None
    }
}

/// B3-G11：图标已确认记录的大小写容错查询 SSOT（db 查询侧）。
/// 收拢散落在调用方的 `to_lowercase` 多段回退；解析器本身保持大小写保留、不被污染。
/// 查询顺序：`app_id` 原值 → `canonical_app_id` → 小写 → `owner/repo`（解析器优先）原值 → 小写；
/// `owner/repo` 优先经 `RepositoryUrlParser::parse(app_id)` 推导（SSOT），回退调用方传入值；命中即返。
pub fn lookup_case_insensitive(
    db: &crate::db::Database,
    app_id: &str,
    owner: &str,
    repo: &str,
) -> Option<crate::db::AppIconCycle> {
    let clean_id = app_id.trim();
    if !clean_id.is_empty() {
        if let Ok(Some(cycle)) = db.get_icon_cycle(clean_id) {
            return Some(cycle);
        }
        if let Some(canon) = canonical_app_id(clean_id) {
            if canon != clean_id {
                if let Ok(Some(cycle)) = db.get_icon_cycle(&canon) {
                    return Some(cycle);
                }
            }
            // canonical 已是小写归一；仅当其与原值小写不一致（如 forge 前缀形态）时再补试小写。
            let lower = clean_id.to_lowercase();
            if lower != clean_id && lower != canon {
                if let Ok(Some(cycle)) = db.get_icon_cycle(&lower) {
                    return Some(cycle);
                }
            }
        } else {
            let lower = clean_id.to_lowercase();
            if lower != clean_id {
                if let Ok(Some(cycle)) = db.get_icon_cycle(&lower) {
                    return Some(cycle);
                }
            }
        }
    }

    // owner/repo 维度：SSOT 经 RepositoryUrlParser 优先推导，回退调用方传入值。
    let (eff_owner, eff_repo) = match RepositoryUrlParser::parse(clean_id) {
        Some(coord) if !coord.owner.is_empty() && !coord.repo.is_empty() => {
            (coord.owner, coord.repo)
        }
        _ => (owner.trim().to_string(), repo.trim().to_string()),
    };
    if !eff_owner.is_empty() && !eff_repo.is_empty() {
        if let Ok(Some(cycle)) = db.get_icon_cycle_by_repo(&eff_owner, &eff_repo) {
            return Some(cycle);
        }
        let lower_o = eff_owner.to_lowercase();
        let lower_r = eff_repo.to_lowercase();
        if lower_o != eff_owner || lower_r != eff_repo {
            if let Ok(Some(cycle)) = db.get_icon_cycle_by_repo(&lower_o, &lower_r) {
                return Some(cycle);
            }
        }
        // 解析器与传入值不一致时，补试传入值（兼容调用方传入与 app_id 不一致的旧数据）。
        let in_o = owner.trim();
        let in_r = repo.trim();
        if !in_o.is_empty() && !in_r.is_empty() && (in_o != eff_owner || in_r != eff_repo) {
            if let Ok(Some(cycle)) = db.get_icon_cycle_by_repo(in_o, in_r) {
                return Some(cycle);
            }
            let ilo = in_o.to_lowercase();
            let ilr = in_r.to_lowercase();
            if ilo != in_o || ilr != in_r {
                if let Ok(Some(cycle)) = db.get_icon_cycle_by_repo(&ilo, &ilr) {
                    return Some(cycle);
                }
            }
        }
    }
    None
}
