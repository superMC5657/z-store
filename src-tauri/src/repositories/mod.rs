//! 仓储层（Layer 2）：收敛跨表事务一致性、`app_details` 联合投影与应用详情决议。

pub mod detail_repo;
pub mod detail_service;

pub use detail_repo::{DetailRepository, EtagWrite};
pub use detail_service::DetailSources;
