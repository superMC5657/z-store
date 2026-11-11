pub mod coord;
pub mod gitea;
pub mod github;
pub mod gitlab;
pub(crate) mod http;
pub mod provider;

#[cfg(test)]
mod tests;

pub use coord::{
    canonical_app_id, canonical_app_id_from_parts, canonical_lookup_id, ForgeType,
    RepositoryUrlParser, UniversalRepoCoord,
};
pub use gitea::GiteaProvider;
pub use github::GitHubProvider;
pub use gitlab::GitLabProvider;
pub use provider::{ForgeProvider, ForgeReleaseInfo, ForgeRepoInfo};

use std::sync::OnceLock;

/// Forge 分发唯一入口：持 `Box<dyn ForgeProvider>` 注册表按 `forge_type` 查找。
pub struct ForgeRegistry;

impl ForgeRegistry {
    /// provider 唯一注册表：Gitea 双形态（Codeberg / 自建 Gitea）按 `forge_type` 区分。
    fn providers() -> &'static [Box<dyn ForgeProvider>] {
        static PROVIDERS: OnceLock<Vec<Box<dyn ForgeProvider>>> = OnceLock::new();
        PROVIDERS.get_or_init(|| {
            vec![
                Box::new(GitHubProvider),
                Box::new(GitLabProvider),
                Box::new(GiteaProvider::new(ForgeType::Codeberg)),
                Box::new(GiteaProvider::new(ForgeType::Gitea)),
            ]
        })
    }

    fn provider_for(forge: ForgeType) -> &'static dyn ForgeProvider {
        Self::providers()
            .iter()
            .find(|p| p.forge_type() == forge)
            .expect("ForgeType 全量注册于 providers 表")
            .as_ref()
    }

    pub async fn fetch_repo(
        coord: &UniversalRepoCoord,
        token: Option<&str>,
    ) -> Result<ForgeRepoInfo, String> {
        Self::provider_for(coord.forge)
            .fetch_repo(&coord.host, &coord.owner, &coord.repo, token)
            .await
    }

    pub async fn fetch_latest_release(
        coord: &UniversalRepoCoord,
        token: Option<&str>,
    ) -> Result<ForgeReleaseInfo, String> {
        Self::provider_for(coord.forge)
            .fetch_latest_release(&coord.host, &coord.owner, &coord.repo, token)
            .await
    }
}
