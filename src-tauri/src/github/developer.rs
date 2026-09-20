//! 开发者画像薄表面：实现位于 sibling 模块（纯搬迁，零行为变更）。
//!
//! - `developer_endpoints`：端点/缓存键构造 + tag 解析 + 常量
//! - `developer_profile`：画像拉取 + ETag 条件请求 helpers
//! - `developer_starred`：Star 同步 + release 富化 + 配额护栏
//! 常量经此重导出，保持既有 `github::developer::X` 路径稳定。
pub use super::developer_endpoints::{
    DEVELOPER_REPOS_PAGE_SIZE, GITHUB_API_BASE, GITHUB_STARRED_MAX_PAGE_SIZE,
    STARRED_RELEASE_ENRICH_LIMIT,
};
