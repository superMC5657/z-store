use serde::{Serialize, Serializer};
use thiserror::Error;

/// 应用统一错误类型（实现 thiserror + Serialize + From 转换链）。
/// 在 Tauri 命令边界序列化为纯错误字符串，完全兼容前端现有错误处理逻辑与文案。
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error(transparent)]
    Database(#[from] rusqlite::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self::Message(msg.into())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::Message(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        Self::Message(s.to_string())
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
