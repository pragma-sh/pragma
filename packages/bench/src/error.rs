//! One error type for the whole benchmark.

use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum BenchError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("`{command}` failed ({status}): {stderr}")]
    Command {
        command: String,
        status: String,
        stderr: String,
    },
    #[error("tauri-agent-tools is not installed (`npm install -g tauri-agent-tools`)")]
    ToolMissing,
    #[error("the page rejected the injected script: {0}")]
    Eval(String),
    #[error("the dev app's bridge is gone and no replacement was found")]
    BridgeGone,
    #[error("timed out after {waited:?} waiting for {what}")]
    Timeout { what: String, waited: Duration },
    #[error("{0}")]
    Setup(String),
    #[error("dev instance exited before the benchmark could drive it; see {log}")]
    DevExited { log: PathBuf },
}

pub type BenchResult<T> = Result<T, BenchError>;
