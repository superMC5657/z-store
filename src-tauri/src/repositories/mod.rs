//! 仓储层（Layer 2）：收敛跨表事务一致性、`catalog_apps` / `custom_apps` / `app_details` 联合投影与同步编排。

pub mod catalog_repo;
pub mod detail_repo;

pub use catalog_repo::CatalogRepository;
pub use detail_repo::{DetailRepository, EtagWrite};
