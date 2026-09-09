pub mod coord;
pub mod gitea;
pub mod github;
pub mod gitlab;
pub mod provider;

#[cfg(test)]
mod tests;

pub use coord::{ForgeType, RepositoryUrlParser, UniversalRepoCoord};
pub use gitea::GiteaProvider;
pub use github::GitHubProvider;
pub use gitlab::GitLabProvider;
pub use provider::{ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};

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
