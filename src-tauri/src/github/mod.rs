pub mod catalog;
pub mod detail;
pub mod developer;
pub mod markdown;
pub mod models;
pub mod search;

#[cfg(test)]
mod tests;

pub use models::{AppRepoCoordinates, CatalogItem};

use std::sync::RwLock;

pub struct CatalogService {
    pub(crate) items: RwLock<Vec<CatalogItem>>,
    pub(crate) client: reqwest::Client,
}
