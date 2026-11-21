//! 仓储层（Layer 2）：收敛跨表事务一致性与 `app_details` 联合投影。

pub mod detail_repo;

pub use detail_repo::{DetailRepository, EtagWrite};
