use crate::models::AppSummary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    pub chinese_name: Option<String>,
    pub owner: String,
    pub repo: String,
    pub icon: String,
    pub icon_bg: String,
    pub description: String,
    pub category: String,
    pub category_name: String,
    pub aliases: Vec<String>,
    pub default_version: String,
    pub license: String,
    pub stars: u64,
    pub forks: u64,
    pub is_verified: bool,
    #[serde(default)]
    pub publisher_fingerprint: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub executables: Vec<String>,
    #[serde(default)]
    pub install_dirs: Vec<String>,
    #[serde(default)]
    pub search_subdirs: Vec<String>,
    #[serde(default)]
    pub publishers: Vec<String>,
}

impl CatalogItem {
    pub fn to_summary(&self) -> AppSummary {
        let effective_icon =
            if self.icon.starts_with("http://") || self.icon.starts_with("https://") {
                self.icon.clone()
            } else {
                format!("https://github.com/{}.png", self.owner)
            };

        AppSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            icon: effective_icon,
            icon_bg: self.icon_bg.clone(),
            description: self.description.clone(),
            stars: self.stars,
            forks: self.forks,
            license: self.license.clone(),
            latest_version: self.default_version.clone(),
            category: self.category.clone(),
            category_name: self.category_name.clone(),
            is_verified: self.is_verified,
            is_installed: None,
            has_update: None,
            installed_version: None,
            forge: Some("github".to_string()),
            forge_host: Some("github.com".to_string()),
            homepage: self.homepage.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct GitHubUserResponse {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub html_url: Option<String>,
    pub bio: Option<String>,
    pub company: Option<String>,
    pub blog: Option<String>,
    pub location: Option<String>,
    pub email: Option<String>,
    pub public_repos: Option<u64>,
    pub followers: Option<u64>,
    pub following: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubRepoResponse {
    pub name: Option<String>,
    pub full_name: Option<String>,
    pub html_url: Option<String>,
    pub description: Option<String>,
    pub stargazers_count: Option<u64>,
    pub forks_count: Option<u64>,
    pub language: Option<String>,
    pub license: Option<GitHubLicense>,
    pub homepage: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubLicense {
    pub spdx_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GitHubReleaseResponse {
    pub tag_name: String,
    pub body: Option<String>,
    pub assets: Vec<GitHubAssetResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GitHubAssetResponse {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubSearchResponse {
    pub items: Vec<GitHubSearchItem>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubSearchItem {
    pub name: String,
    pub full_name: String,
    pub owner: GitHubSearchOwner,
    pub description: Option<String>,
    pub stargazers_count: u64,
    pub forks_count: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitHubSearchOwner {
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRepoCoordinates {
    pub owner: String,
    pub repo: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_bg: String,
}
