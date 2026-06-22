use std::sync::PoisonError;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("daemon error: {0}")]
    Daemon(String),
    #[error("git error: {0}")]
    Git(String),
    #[error("browser error: {0}")]
    Browser(String),
    #[error("github error: {0}")]
    GitHub(String),
    #[error("script error: {0}")]
    Script(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

impl From<pragma_protocol::ProtocolError> for AppError {
    fn from(error: pragma_protocol::ProtocolError) -> Self {
        Self::Daemon(error.to_string())
    }
}

impl<T> From<PoisonError<T>> for AppError {
    fn from(_: PoisonError<T>) -> Self {
        Self::LockPoisoned
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
