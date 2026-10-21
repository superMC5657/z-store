//! 用户数据导入：备份 JSON 的允许合入白名单与解析。

pub mod import;

pub use import::{parse_import_payload, validate_app_id, ImportPlan, IMPORT_SETTINGS_ALLOWLIST};

#[cfg(test)]
mod tests;
