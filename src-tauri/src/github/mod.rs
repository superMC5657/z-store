pub mod asset_fetch;
pub mod catalog_feed_score;
pub mod catalog_service;
pub mod detail_assets;
pub mod detail_fetch;
pub mod developer_endpoints;
pub mod developer_profile;
pub mod developer_starred;
#[cfg(test)]
mod developer_starred_tests;
pub mod http;
pub mod icon_fetch;
pub mod icon_probe;
pub mod image_sniff;
pub mod markdown;
pub mod models;
pub mod readme_variants;
pub mod release_fetch;
pub mod search;

#[cfg(test)]
mod tests;

pub use models::{AppRepoCoordinates, CatalogItem};

use std::sync::RwLock;

pub struct CatalogService {
    pub(crate) items: RwLock<Vec<CatalogItem>>,
    pub(crate) client: reqwest::Client,
}
