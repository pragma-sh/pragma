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
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("lock poisoned")]
    LockPoisoned,
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
