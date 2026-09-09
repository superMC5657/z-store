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

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::Codeberg => "Codeberg",
            Self::Gitea => "Gitea / Forgejo",
            Self::GitLab => "GitLab",
        }
    }

    pub fn icon(&self) -> &'static str {
        match self {
            Self::GitHub => "🐙",
            Self::Codeberg => "🏔️",
            Self::Gitea => "🍵",
            Self::GitLab => "🦊",
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

    pub fn web_url(&self) -> String {
        format!("https://{}/{}/{}", self.host, self.owner, self.repo)
    }

    pub fn to_repo_key(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.repo).to_lowercase()
    }
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
