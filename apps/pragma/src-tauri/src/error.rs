use serde::Serialize;

/// Unified error type for Tauri commands.
///
/// Serialized as a plain message string to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Daemon(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
