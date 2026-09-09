use super::coord::{ForgeType, UniversalRepoCoord};
use crate::models::ReleaseAsset;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeRepoInfo {
    pub coord: UniversalRepoCoord,
    pub name: String,
    pub description: Option<String>,
    pub stars: u64,
    pub forks: u64,
    pub language: Option<String>,
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
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
