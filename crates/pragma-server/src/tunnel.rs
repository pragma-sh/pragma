//! Persistent remote-access tunnel supervisor.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use pragma_constants::CONSTANTS;

const PORT_PLACEHOLDER: &str = "{port}";

#[derive(Debug, Error)]
pub enum TunnelError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state", content = "value")]
enum TunnelStatus {
    #[default]
    Idle,
    Starting,
    Active(String),
    Error(String),
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelConfig {
    #[serde(default)]
    enabled: bool,
    command: Option<String>,
    url_pattern: Option<String>,
}

pub struct TunnelRegistry {
    server_dir: PathBuf,
    status: Arc<Mutex<TunnelStatus>>,
    child: Mutex<Option<Child>>,
    generation: Arc<AtomicU64>,
}

impl TunnelRegistry {
    pub fn new(server_dir: PathBuf) -> Arc<Self> {
        let registry = Arc::new(Self {
            server_dir,
            status: Arc::new(Mutex::new(TunnelStatus::Idle)),
            child: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
        });
        if Self::read_config().is_ok_and(|config| config.enabled) {
            let weak = Arc::downgrade(&registry);
            thread::spawn(move || {
                if let Some(registry) = weak.upgrade() {
                    for _ in 0..100 {
                        if registry.start().is_ok() {
                            return;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            });
        }
        registry
    }

    pub fn handle_rpc(&self, payload: &Value) -> Result<Value, TunnelError> {
        match payload.get("action").and_then(Value::as_str) {
            Some("start") => {
                Self::set_enabled(true)?;
                self.start()?;
                self.status_json()
            }
            Some("stop") => {
                Self::set_enabled(false)?;
                self.stop();
                self.status_json()
            }
            Some("status") => self.status_json(),
            _ => Err(TunnelError::Message("unknown tunnel action".to_string())),
        }
    }

    fn status_json(&self) -> Result<Value, TunnelError> {
        let status = self
            .status
            .lock()
            .map_err(|error| TunnelError::Message(error.to_string()))?;
        Ok(serde_json::to_value(&*status)?)
    }

    fn start(&self) -> Result<(), TunnelError> {
        self.stop();
        let config = Self::read_config()?;
        let port = self.gateway_port()?;
        let pattern = Regex::new(
            config
                .url_pattern
                .as_deref()
                .unwrap_or(&CONSTANTS.tunnel.default_url_pattern),
        )
        .map_err(|error| TunnelError::Message(format!("invalid tunnel urlPattern: {error}")))?;
        let command = config
            .command
            .unwrap_or_else(|| CONSTANTS.tunnel.default_command.clone())
            .replace(PORT_PLACEHOLDER, &port.to_string());
        let mut parts = command.split_whitespace();
        let program = parts
            .next()
            .ok_or_else(|| TunnelError::Message("tunnel command is empty".to_string()))?;
        self.set_status(TunnelStatus::Starting);
        let child = Command::new(program)
            .args(parts)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                let message = format!("failed to start tunnel: {error}");
                self.set_status(TunnelStatus::Error(message.clone()));
                return Err(TunnelError::Message(message));
            }
        };
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some(stdout) = child.stdout.take() {
            self.spawn_scanner(stdout, pattern.clone(), generation);
        }
        if let Some(stderr) = child.stderr.take() {
            self.spawn_scanner(stderr, pattern, generation);
        }
        *self
            .child
            .lock()
            .map_err(|error| TunnelError::Message(error.to_string()))? = Some(child);
        Ok(())
    }

    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut running) = child.take() {
                let _ = running.kill();
                let _ = running.wait();
            }
        }
        self.set_status(TunnelStatus::Idle);
    }

    fn spawn_scanner<R: Read + Send + 'static>(&self, reader: R, pattern: Regex, generation: u64) {
        let status = Arc::clone(&self.status);
        let live_generation = Arc::clone(&self.generation);
        thread::spawn(move || {
            let mut last_line = String::new();
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                if let Some(url) = extract_url(&pattern, &line) {
                    if live_generation.load(Ordering::SeqCst) == generation {
                        if let Ok(mut current) = status.lock() {
                            *current = TunnelStatus::Active(url);
                        }
                    }
                }
                if !line.trim().is_empty() {
                    last_line = line;
                }
            }
            if live_generation.load(Ordering::SeqCst) == generation {
                if let Ok(mut current) = status.lock() {
                    *current = TunnelStatus::Error(format!(
                        "tunnel exited: {}",
                        if last_line.is_empty() {
                            "no output"
                        } else {
                            &last_line
                        }
                    ));
                }
            }
        });
    }

    fn set_status(&self, next: TunnelStatus) {
        if let Ok(mut status) = self.status.lock() {
            *status = next;
        }
    }

    fn gateway_port(&self) -> Result<u16, TunnelError> {
        let path = self
            .server_dir
            .join(CONSTANTS.gateway.discovery_file.as_str());
        let discovery: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        discovery
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| TunnelError::Message("gateway discovery has no port".to_string()))
    }

    fn read_config() -> Result<TunnelConfig, TunnelError> {
        let value = read_config_value(&config_path())?;
        Ok(serde_json::from_value(
            value.get("tunnel").cloned().unwrap_or_else(|| json!({})),
        )?)
    }

    fn set_enabled(enabled: bool) -> Result<(), TunnelError> {
        let path = config_path();
        let mut value = read_config_value(&path)?;
        set_enabled_value(&mut value, enabled)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(&value)?)?;
        Ok(())
    }
}

fn config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
        .join(".pragma/config.json")
}

fn read_config_value(path: &Path) -> Result<Value, TunnelError> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.into()),
    }
}

fn set_enabled_value(value: &mut Value, enabled: bool) -> Result<(), TunnelError> {
    let root = value.as_object_mut().ok_or_else(|| {
        TunnelError::Message("~/.pragma/config.json must be an object".to_string())
    })?;
    let tunnel = root.entry("tunnel").or_insert_with(|| json!({}));
    tunnel
        .as_object_mut()
        .ok_or_else(|| TunnelError::Message("tunnel config must be an object".to_string()))?
        .insert("enabled".to_string(), Value::Bool(enabled));
    Ok(())
}

fn extract_url(pattern: &Regex, line: &str) -> Option<String> {
    pattern
        .captures(line)
        .and_then(|captures| captures.get(1).or_else(|| captures.get(0)))
        .map(|matched| matched.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_ngrok_url() {
        let pattern = Regex::new(&CONSTANTS.tunnel.default_url_pattern).expect("pattern");
        assert_eq!(
            extract_url(&pattern, r#"{"url":"https://abc.ngrok-free.app"}"#).as_deref(),
            Some("https://abc.ngrok-free.app")
        );
    }

    #[test]
    fn enabling_tunnel_preserves_existing_config() {
        let mut value = json!({
            "plugins": [{ "source": "example" }],
            "tunnel": { "command": "cloudflared tunnel" }
        });
        set_enabled_value(&mut value, true).expect("enable");
        assert_eq!(value["tunnel"]["enabled"], true);
        assert_eq!(value["tunnel"]["command"], "cloudflared tunnel");
        assert_eq!(value["plugins"][0]["source"], "example");
    }
}
