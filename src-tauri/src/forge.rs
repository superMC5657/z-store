use crate::installer::InstallerEngine;
use crate::models::ReleaseAsset;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
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
            format!("{}:{}/{}/{}", self.forge.as_str(), self.host, self.owner, self.repo)
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeRepoInfo {
    pub coord: UniversalRepoCoord,
    pub name: String,
    pub description: Option<String>,
    pub stars: u64,
    pub forks: u64,
    pub language: Option<String>,
    pub default_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

#[allow(async_fn_in_trait)]
pub trait ForgeProvider: Send + Sync {
    fn forge_type(&self) -> ForgeType;
    fn default_host(&self) -> &str;

    async fn fetch_repo(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String>;

    async fn fetch_latest_release(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String>;

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String>;
}

pub struct GitHubProvider;

impl ForgeProvider for GitHubProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitHub
    }

    fn default_host(&self) -> &str {
        "github.com"
    }

    async fn fetch_repo(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("GitHub API 响应失败: {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubRepoPayload {
            name: String,
            description: Option<String>,
            stargazers_count: Option<u64>,
            forks_count: Option<u64>,
            language: Option<String>,
            default_branch: Option<String>,
        }

        let payload: GitHubRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

        Ok(ForgeRepoInfo {
            coord: UniversalRepoCoord {
                forge: ForgeType::GitHub,
                host: "github.com".to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
            },
            name: payload.name,
            description: payload.description,
            stars: payload.stargazers_count.unwrap_or(0),
            forks: payload.forks_count.unwrap_or(0),
            language: payload.language,
            default_branch: payload.default_branch.unwrap_or_else(|| "main".to_string()),
        })
    }

    async fn fetch_latest_release(
        &self,
        _host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!("https://api.github.com/repos/{}/{}/releases/latest", owner, repo);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("获取 GitHub Release 失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubAsset {
            name: String,
            browser_download_url: String,
            size: u64,
        }

        #[derive(Deserialize)]
        struct GitHubRelease {
            tag_name: String,
            name: Option<String>,
            body: Option<String>,
            published_at: Option<String>,
            assets: Vec<GitHubAsset>,
        }

        let release: GitHubRelease = resp.json().await.map_err(|e| e.to_string())?;

        let assets = release
            .assets
            .into_iter()
            .map(|a| {
                let (kind, os, arch) = InstallerEngine::classify_asset(&a.name);
                let kind_str = match kind {
                    crate::installer::AssetKind::Msi => "msi",
                    crate::installer::AssetKind::SetupExe => "setup_exe",
                    crate::installer::AssetKind::PortableZip => "portable_zip",
                    crate::installer::AssetKind::Deb => "deb",
                    crate::installer::AssetKind::Rpm => "rpm",
                    crate::installer::AssetKind::AppImage => "appimage",
                    crate::installer::AssetKind::Dmg => "dmg",
                    crate::installer::AssetKind::Pkg => "pkg",
                    crate::installer::AssetKind::Apk => "apk",
                    crate::installer::AssetKind::Other => "other",
                };
                ReleaseAsset {
                    name: a.name,
                    download_url: a.browser_download_url,
                    size_bytes: a.size,
                    sha256: None,
                    os: os.to_string(),
                    arch: arch.to_string(),
                    kind: kind_str.to_string(),
                }
            })
            .collect();

        Ok(ForgeReleaseInfo {
            tag_name: release.tag_name,
            name: release.name,
            body: release.body,
            published_at: release.published_at,
            assets,
        })
    }

    async fn search_repos(
        &self,
        _host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github.v3+json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_q = urlencoding::encode(query);
        let url = format!("https://api.github.com/search/repositories?q={}&per_page=10", encoded_q);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("GitHub 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitHubSearchOwner {
            login: String,
        }

        #[derive(Deserialize)]
        struct GitHubSearchItem {
            name: String,
            description: Option<String>,
            stargazers_count: Option<u64>,
            forks_count: Option<u64>,
            language: Option<String>,
            default_branch: Option<String>,
            owner: GitHubSearchOwner,
        }

        #[derive(Deserialize)]
        struct GitHubSearchResult {
            items: Option<Vec<GitHubSearchItem>>,
        }

        let result: GitHubSearchResult = resp.json().await.map_err(|e| e.to_string())?;
        let items = result
            .items
            .unwrap_or_default()
            .into_iter()
            .map(|item| ForgeRepoInfo {
                coord: UniversalRepoCoord {
                    forge: ForgeType::GitHub,
                    host: "github.com".to_string(),
                    owner: item.owner.login,
                    repo: item.name.clone(),
                },
                name: item.name,
                description: item.description,
                stars: item.stargazers_count.unwrap_or(0),
                forks: item.forks_count.unwrap_or(0),
                language: item.language,
                default_branch: item.default_branch.unwrap_or_else(|| "main".to_string()),
            })
            .collect();

        Ok(items)
    }
}

pub struct GiteaProvider {
    pub forge_type: ForgeType,
}

impl GiteaProvider {
    pub fn new(forge_type: ForgeType) -> Self {
        Self { forge_type }
    }
}

impl ForgeProvider for GiteaProvider {
    fn forge_type(&self) -> ForgeType {
        self.forge_type
    }

    fn default_host(&self) -> &str {
        match self.forge_type {
            ForgeType::Codeberg => "codeberg.org",
            _ => "gitea.com",
        }
    }

    async fn fetch_repo(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        // Gitea / Forgejo API v1
        let url = format!("https://{}/api/v1/repos/{}/{}", host, owner, repo);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Gitea/Codeberg API 响应失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GiteaRepoPayload {
            name: String,
            description: Option<String>,
            stars_count: Option<u64>,
            forks_count: Option<u64>,
            primary_language: Option<String>,
            default_branch: Option<String>,
        }

        let payload: GiteaRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

        Ok(ForgeRepoInfo {
            coord: UniversalRepoCoord {
                forge: self.forge_type,
                host: host.to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
            },
            name: payload.name,
            description: payload.description,
            stars: payload.stars_count.unwrap_or(0),
            forks: payload.forks_count.unwrap_or(0),
            language: payload.primary_language,
            default_branch: payload.default_branch.unwrap_or_else(|| "main".to_string()),
        })
    }

    async fn fetch_latest_release(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let url = format!("https://{}/api/v1/repos/{}/{}/releases/latest", host, owner, repo);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("获取 Gitea/Codeberg Release 失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GiteaAsset {
            name: String,
            browser_download_url: String,
            size: u64,
        }

        #[derive(Deserialize)]
        struct GiteaRelease {
            tag_name: String,
            name: Option<String>,
            body: Option<String>,
            published_at: Option<String>,
            assets: Option<Vec<GiteaAsset>>,
        }

        let release: GiteaRelease = resp.json().await.map_err(|e| e.to_string())?;

        let assets = release
            .assets
            .unwrap_or_default()
            .into_iter()
            .map(|a| {
                let (kind, os, arch) = InstallerEngine::classify_asset(&a.name);
                let kind_str = match kind {
                    crate::installer::AssetKind::Msi => "msi",
                    crate::installer::AssetKind::SetupExe => "setup_exe",
                    crate::installer::AssetKind::PortableZip => "portable_zip",
                    crate::installer::AssetKind::Deb => "deb",
                    crate::installer::AssetKind::Rpm => "rpm",
                    crate::installer::AssetKind::AppImage => "appimage",
                    crate::installer::AssetKind::Dmg => "dmg",
                    crate::installer::AssetKind::Pkg => "pkg",
                    crate::installer::AssetKind::Apk => "apk",
                    crate::installer::AssetKind::Other => "other",
                };
                ReleaseAsset {
                    name: a.name,
                    download_url: a.browser_download_url,
                    size_bytes: a.size,
                    sha256: None,
                    os: os.to_string(),
                    arch: arch.to_string(),
                    kind: kind_str.to_string(),
                }
            })
            .collect();

        Ok(ForgeReleaseInfo {
            tag_name: release.tag_name,
            name: release.name,
            body: release.body,
            published_at: release.published_at,
            assets,
        })
    }

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("token {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_q = urlencoding::encode(query);
        let url = format!("https://{}/api/v1/repos/search?q={}&limit=10", host, encoded_q);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Gitea/Codeberg 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GiteaSearchOwner {
            login: String,
        }

        #[derive(Deserialize)]
        struct GiteaSearchItem {
            name: String,
            description: Option<String>,
            stars_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
            owner: GiteaSearchOwner,
        }

        #[derive(Deserialize)]
        struct GiteaSearchResult {
            data: Option<Vec<GiteaSearchItem>>,
        }

        let result: GiteaSearchResult = resp.json().await.map_err(|e| e.to_string())?;
        let items = result
            .data
            .unwrap_or_default()
            .into_iter()
            .map(|item| ForgeRepoInfo {
                coord: UniversalRepoCoord {
                    forge: self.forge_type,
                    host: host.to_string(),
                    owner: item.owner.login,
                    repo: item.name.clone(),
                },
                name: item.name,
                description: item.description,
                stars: item.stars_count.unwrap_or(0),
                forks: item.forks_count.unwrap_or(0),
                language: None,
                default_branch: item.default_branch.unwrap_or_else(|| "main".to_string()),
            })
            .collect();

        Ok(items)
    }
}

pub struct GitLabProvider;

impl ForgeProvider for GitLabProvider {
    fn forge_type(&self) -> ForgeType {
        ForgeType::GitLab
    }

    fn default_host(&self) -> &str {
        "gitlab.com"
    }

    async fn fetch_repo(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_path = format!("{}%2F{}", urlencoding::encode(owner), urlencoding::encode(repo));
        let url = format!("https://{}/api/v4/projects/{}", host, encoded_path);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("GitLab API 响应失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitLabRepoPayload {
            name: String,
            description: Option<String>,
            star_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
        }

        let payload: GitLabRepoPayload = resp.json().await.map_err(|e| e.to_string())?;

        Ok(ForgeRepoInfo {
            coord: UniversalRepoCoord {
                forge: ForgeType::GitLab,
                host: host.to_string(),
                owner: owner.to_string(),
                repo: repo.to_string(),
            },
            name: payload.name,
            description: payload.description,
            stars: payload.star_count.unwrap_or(0),
            forks: payload.forks_count.unwrap_or(0),
            language: None,
            default_branch: payload.default_branch.unwrap_or_else(|| "main".to_string()),
        })
    }

    async fn fetch_latest_release(
        &self,
        host: &str,
        owner: &str,
        repo: &str,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        #[derive(Deserialize)]
        struct GitLabAssetLink {
            name: String,
            url: String,
            direct_asset_url: Option<String>,
        }

        #[derive(Deserialize)]
        struct GitLabReleaseAssets {
            links: Option<Vec<GitLabAssetLink>>,
        }

        #[derive(Deserialize)]
        struct GitLabReleasePayload {
            tag_name: String,
            name: Option<String>,
            description: Option<String>,
            released_at: Option<String>,
            assets: Option<GitLabReleaseAssets>,
        }

        let encoded_path = format!("{}%2F{}", urlencoding::encode(owner), urlencoding::encode(repo));
        let latest_url = format!(
            "https://{}/api/v4/projects/{}/releases/permalink/latest",
            host, encoded_path
        );

        let resp = client
            .get(&latest_url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let release: GitLabReleasePayload = if resp.status().is_success() {
            resp.json().await.map_err(|e| e.to_string())?
        } else {
            // 回退到 /releases 列表首项
            let list_url = format!("https://{}/api/v4/projects/{}/releases?per_page=1", host, encoded_path);
            let list_resp = client.get(&list_url).headers(headers).send().await.map_err(|e| e.to_string())?;
            if !list_resp.status().is_success() {
                return Err(format!("获取 GitLab Release 失败: HTTP {}", list_resp.status()));
            }
            let list: Vec<GitLabReleasePayload> = list_resp.json().await.map_err(|e| e.to_string())?;
            list.into_iter().next().ok_or_else(|| "该 GitLab 项目未找到任何 Release".to_string())?
        };

        let mut assets = Vec::new();
        if let Some(rel_assets) = release.assets {
            if let Some(links) = rel_assets.links {
                for l in links {
                    let (kind, os, arch) = InstallerEngine::classify_asset(&l.name);
                    let dl_url = l.direct_asset_url.unwrap_or(l.url);
                    let kind_str = match kind {
                        crate::installer::AssetKind::Msi => "msi",
                        crate::installer::AssetKind::SetupExe => "setup_exe",
                        crate::installer::AssetKind::PortableZip => "portable_zip",
                        crate::installer::AssetKind::Deb => "deb",
                        crate::installer::AssetKind::Rpm => "rpm",
                        crate::installer::AssetKind::AppImage => "appimage",
                        crate::installer::AssetKind::Dmg => "dmg",
                        crate::installer::AssetKind::Pkg => "pkg",
                        crate::installer::AssetKind::Apk => "apk",
                        crate::installer::AssetKind::Other => "other",
                    };
                    assets.push(ReleaseAsset {
                        name: l.name,
                        download_url: dl_url,
                        size_bytes: 0,
                        sha256: None,
                        os: os.to_string(),
                        arch: arch.to_string(),
                        kind: kind_str.to_string(),
                    });
                }
            }
        }

        Ok(ForgeReleaseInfo {
            tag_name: release.tag_name,
            name: release.name,
            body: release.description,
            published_at: release.released_at,
            assets,
        })
    }

    async fn search_repos(
        &self,
        host: &str,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("ZStore-Client/0.1.0"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(tok) = token {
            if !tok.trim().is_empty() {
                if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", tok.trim())) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }

        let encoded_q = urlencoding::encode(query);
        let url = format!("https://{}/api/v4/projects?search={}&per_page=10", host, encoded_q);
        let resp = client.get(&url).headers(headers).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("GitLab 搜索失败: HTTP {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct GitLabNamespace {
            path: String,
        }

        #[derive(Deserialize)]
        struct GitLabProjectItem {
            name: String,
            path: String,
            description: Option<String>,
            star_count: Option<u64>,
            forks_count: Option<u64>,
            default_branch: Option<String>,
            namespace: GitLabNamespace,
        }

        let items: Vec<GitLabProjectItem> = resp.json().await.map_err(|e| e.to_string())?;
        let result = items
            .into_iter()
            .map(|item| ForgeRepoInfo {
                coord: UniversalRepoCoord {
                    forge: ForgeType::GitLab,
                    host: host.to_string(),
                    owner: item.namespace.path,
                    repo: item.path,
                },
                name: item.name,
                description: item.description,
                stars: item.star_count.unwrap_or(0),
                forks: item.forks_count.unwrap_or(0),
                language: None,
                default_branch: item.default_branch.unwrap_or_else(|| "main".to_string()),
            })
            .collect();

        Ok(result)
    }
}

pub struct ForgeRegistry;

impl ForgeRegistry {
    pub async fn fetch_repo(
        coord: &UniversalRepoCoord,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        match coord.forge {
            ForgeType::GitHub => {
                GitHubProvider
                    .fetch_repo(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::Codeberg => {
                GiteaProvider::new(ForgeType::Codeberg)
                    .fetch_repo(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::Gitea => {
                GiteaProvider::new(ForgeType::Gitea)
                    .fetch_repo(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::GitLab => {
                GitLabProvider
                    .fetch_repo(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
        }
    }

    pub async fn fetch_latest_release(
        coord: &UniversalRepoCoord,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        match coord.forge {
            ForgeType::GitHub => {
                GitHubProvider
                    .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::Codeberg => {
                GiteaProvider::new(ForgeType::Codeberg)
                    .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::Gitea => {
                GiteaProvider::new(ForgeType::Gitea)
                    .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
            ForgeType::GitLab => {
                GitLabProvider
                    .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token)
                    .await
            }
        }
    }

    pub async fn search_repos(
        forge: ForgeType,
        host: Option<&str>,
        query: &str,
        token: Option<&str>,
    ) -> Result<Vec<ForgeRepoInfo>, String> {
        match forge {
            ForgeType::GitHub => GitHubProvider.search_repos("github.com", query, token).await,
            ForgeType::Codeberg => {
                GiteaProvider::new(ForgeType::Codeberg)
                    .search_repos(host.unwrap_or("codeberg.org"), query, token)
                    .await
            }
            ForgeType::Gitea => {
                GiteaProvider::new(ForgeType::Gitea)
                    .search_repos(host.unwrap_or("gitea.com"), query, token)
                    .await
            }
            ForgeType::GitLab => {
                GitLabProvider
                    .search_repos(host.unwrap_or("gitlab.com"), query, token)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repository_url_parser() {
        // 1. Web URL: Codeberg
        let cb = RepositoryUrlParser::parse("https://codeberg.org/FreeTube/FreeTube").unwrap();
        assert_eq!(cb.forge, ForgeType::Codeberg);
        assert_eq!(cb.host, "codeberg.org");
        assert_eq!(cb.owner, "FreeTube");
        assert_eq!(cb.repo, "FreeTube");
        assert_eq!(cb.to_app_id(), "codeberg:FreeTube/FreeTube");

        // 2. Web URL: GitHub with .git
        let gh = RepositoryUrlParser::parse("https://github.com/localsend/localsend.git").unwrap();
        assert_eq!(gh.forge, ForgeType::GitHub);
        assert_eq!(gh.host, "github.com");
        assert_eq!(gh.owner, "localsend");
        assert_eq!(gh.repo, "localsend");
        assert_eq!(gh.to_app_id(), "localsend/localsend");

        // 3. Web URL: 自建 Gitea / Forgejo 实例
        let custom = RepositoryUrlParser::parse("https://git.disroot.org/user/my-app/").unwrap();
        assert_eq!(custom.forge, ForgeType::Gitea);
        assert_eq!(custom.host, "git.disroot.org");
        assert_eq!(custom.owner, "user");
        assert_eq!(custom.repo, "my-app");
        assert_eq!(custom.to_app_id(), "gitea:git.disroot.org/user/my-app");

        // 4. 短语法: codeberg:owner/repo
        let cb_short = RepositoryUrlParser::parse("codeberg:author/repo").unwrap();
        assert_eq!(cb_short.forge, ForgeType::Codeberg);
        assert_eq!(cb_short.owner, "author");
        assert_eq!(cb_short.repo, "repo");

        // 5. 传统 owner/repo
        let legacy = RepositoryUrlParser::parse("rustdesk/rustdesk").unwrap();
        assert_eq!(legacy.forge, ForgeType::GitHub);
        assert_eq!(legacy.owner, "rustdesk");
        assert_eq!(legacy.repo, "rustdesk");
        assert_eq!(legacy.to_app_id(), "rustdesk/rustdesk");

        // 6. Web URL: GitLab
        let gl = RepositoryUrlParser::parse("https://gitlab.com/inkscape/inkscape").unwrap();
        assert_eq!(gl.forge, ForgeType::GitLab);
        assert_eq!(gl.host, "gitlab.com");
        assert_eq!(gl.owner, "inkscape");
        assert_eq!(gl.repo, "inkscape");
        assert_eq!(gl.to_app_id(), "gitlab:inkscape/inkscape");

        // 7. 无效字符
        assert!(RepositoryUrlParser::parse("invalid query here").is_none());
        assert!(RepositoryUrlParser::parse("").is_none());
    }

    #[test]
    fn test_forge_type_metadata() {
        assert_eq!(ForgeType::GitHub.icon(), "🐙");
        assert_eq!(ForgeType::Codeberg.icon(), "🏔️");
        assert_eq!(ForgeType::Gitea.icon(), "🍵");
        assert_eq!(ForgeType::GitLab.icon(), "🦊");
        assert_eq!(ForgeType::GitHub.default_host(), "github.com");
        assert_eq!(ForgeType::Codeberg.default_host(), "codeberg.org");
        assert_eq!(ForgeType::GitLab.default_host(), "gitlab.com");
    }
}
