//! 仓储层（Layer 2）：收敛跨表事务一致性、`app_details` 联合投影、应用详情决议与单仓富卡水合。

pub mod card_hydrator;
pub mod detail_repo;
pub mod detail_service;

pub use detail_repo::{DetailRepository, EtagWrite};
pub use detail_service::DetailSources;
