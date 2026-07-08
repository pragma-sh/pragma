//! Remote-access tunnel supervisor.
//!
//! Exposes the local HTTP gateway to a paired mobile device by spawning a
//! user-configured tunnel process (ngrok by default) and scraping its public
//! URL from stdout/stderr. The command and URL-matching regex are read from the
//! `tunnel` key of `~/.pragma/config.json`, falling back to the shipped defaults
//! in `@pragma/constants` so Rust and any TypeScript config UI agree.
//!
//! The tunnel is deliberately independent of the pair modal's lifetime: it is
//! started/stopped explicitly and survives the modal closing. The child is
//! killed on `tunnel_stop` and on app exit.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use regex::Regex;
use serde::{Deserialize, Serialize};

use pragma_constants::CONSTANTS;

use crate::error::{AppError, AppResult};
use crate::plugins;

/// Placeholder replaced with the live gateway port in a tunnel command.
const PORT_PLACEHOLDER: &str = "{port}";

/// Current tunnel lifecycle state, surfaced to the frontend as a discriminated
/// union `{ state, value? }`.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state", content = "value")]
pub enum TunnelStatus {
    /// No tunnel process is running.
    #[default]
    Idle,
    /// A tunnel process has spawned but no public URL is known yet.
    Starting,
    /// A public URL was scraped from the tunnel output.
    Active(String),
    /// The tunnel failed to start or exited before publishing a URL.
    Error(String),
}

/// The `tunnel` subset of `~/.pragma/config.json`. Unknown keys are ignored so
/// other Pragma features can share the file.
#[derive(Debug, Default, Deserialize)]
struct TunnelConfigFile {
    #[serde(default)]
    tunnel: Option<TunnelConfigEntry>,
}

/// User overrides for the tunnel command and URL pattern.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelConfigEntry {
    command: Option<String>,
    url_pattern: Option<String>,
}

/// Resolved tunnel configuration: a command template plus the URL regex.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TunnelConfig {
    command: String,
    url_pattern: String,
}

/// Managed Tauri state owning the tunnel child process and its status.
#[derive(Default)]
pub struct TunnelState {
    status: Arc<Mutex<TunnelStatus>>,
    child: Mutex<Option<Child>>,
}

impl TunnelState {
    /// Returns the current tunnel status.
    #[must_use]
    pub fn status(&self) -> TunnelStatus {
        self.status.lock().map_or(TunnelStatus::Idle, |s| s.clone())
    }

    /// Kills any running tunnel and resets the status to `Idle`.
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut running) = child.take() {
                let _ = running.kill();
                let _ = running.wait();
            }
        }
        self.set_status(TunnelStatus::Idle);
    }

    /// Starts a tunnel for `port`, replacing any existing one. Reader threads
    /// scrape the public URL from stdout and stderr and flip the status to
    /// `Active`; the returned status is `Starting` unless the URL was already
    /// seen. A missing tunnel binary becomes an `AppError::Tunnel` the modal can
    /// render.
    pub fn start(&self, home_dir: &Path, port: u16) -> AppResult<TunnelStatus> {
        self.stop();
        let config = resolve_config(home_dir)?;
        let pattern = Regex::new(&config.url_pattern)
            .map_err(|error| AppError::Tunnel(format!("invalid tunnel urlPattern: {error}")))?;
        let command = config.command.replace(PORT_PLACEHOLDER, &port.to_string());
        let (program, args) = split_command(&command)
            .ok_or_else(|| AppError::Tunnel("tunnel command is empty".to_string()))?;

        self.set_status(TunnelStatus::Starting);
        let mut child = Command::new(&program)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|error| {
                let message = if error.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "tunnel command not found: {program}. Install it or set \
                         tunnel.command in ~/.pragma/config.json."
                    )
                } else {
                    format!("failed to start tunnel: {error}")
                };
                self.set_status(TunnelStatus::Error(message.clone()));
                AppError::Tunnel(message)
            })?;

        if let Some(stdout) = child.stdout.take() {
            self.spawn_scanner(stdout, pattern.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            self.spawn_scanner(stderr, pattern);
        }

        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
        Ok(self.status())
    }

    /// Spawns a reader thread that scans each line of `reader` for the tunnel
    /// URL, flipping the status to `Active` on the first match.
    fn spawn_scanner<R: Read + Send + 'static>(&self, reader: R, pattern: Regex) {
        let status = Arc::clone(&self.status);
        thread::spawn(move || {
            let buffered = BufReader::new(reader);
            for line in buffered.lines().map_while(Result::ok) {
                if let Some(url) = extract_url(&pattern, &line) {
                    if let Ok(mut current) = status.lock() {
                        // Only the first URL wins; later lines are drained so the
                        // pipe never blocks the child.
                        if !matches!(*current, TunnelStatus::Active(_)) {
                            *current = TunnelStatus::Active(url);
                        }
                    }
                }
            }
        });
    }

    fn set_status(&self, status: TunnelStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }
}

/// Reads and resolves tunnel config from `~/.pragma/config.json`, applying the
/// shipped defaults for any missing field.
fn resolve_config(home_dir: &Path) -> AppResult<TunnelConfig> {
    let path = plugins::config_path(home_dir);
    let file: TunnelConfigFile = match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| AppError::Tunnel(format!("invalid ~/.pragma/config.json: {error}")))?,
        Err(_) => TunnelConfigFile::default(),
    };
    let entry = file.tunnel.unwrap_or_default();
    Ok(TunnelConfig {
        command: entry
            .command
            .unwrap_or_else(|| CONSTANTS.tunnel.default_command.clone()),
        url_pattern: entry
            .url_pattern
            .unwrap_or_else(|| CONSTANTS.tunnel.default_url_pattern.clone()),
    })
}

/// Splits a command string into program + args on whitespace. `{port}` is the
/// only supported template variable and is substituted before this call, so a
/// simple split is sufficient for the shipped commands.
fn split_command(command: &str) -> Option<(String, Vec<String>)> {
    let mut parts = command.split_whitespace().map(str::to_string);
    let program = parts.next()?;
    Some((program, parts.collect()))
}

/// Returns the first capture group of `pattern` in `line`, i.e. the public URL.
fn extract_url(pattern: &Regex, line: &str) -> Option<String> {
    pattern
        .captures(line)
        .and_then(|caps| caps.get(1).or_else(|| caps.get(0)))
        .map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_pattern() -> Regex {
        Regex::new(&CONSTANTS.tunnel.default_url_pattern).expect("valid default pattern")
    }

    #[test]
    fn substitutes_port_placeholder() {
        let command = CONSTANTS
            .tunnel
            .default_command
            .replace(PORT_PLACEHOLDER, "49152");
        assert!(command.contains("49152"));
        assert!(!command.contains(PORT_PLACEHOLDER));
    }

    #[test]
    fn extracts_url_from_ngrok_json_line() {
        let line =
            r#"{"lvl":"info","msg":"started tunnel","url":"https://abc-123.ngrok-free.app"}"#;
        assert_eq!(
            extract_url(&default_pattern(), line).as_deref(),
            Some("https://abc-123.ngrok-free.app")
        );
    }

    #[test]
    fn extracts_url_from_cloudflared_plain_line() {
        let line = "2024-01-01 INF |  https://random-words.trycloudflare.com  |";
        assert_eq!(
            extract_url(&default_pattern(), line).as_deref(),
            Some("https://random-words.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_lines_without_a_url() {
        assert_eq!(extract_url(&default_pattern(), "starting tunnel..."), None);
    }

    #[test]
    fn splits_command_into_program_and_args() {
        let (program, args) = split_command("ngrok http 49152 --log stdout").expect("split");
        assert_eq!(program, "ngrok");
        assert_eq!(args, vec!["http", "49152", "--log", "stdout"]);
    }
}
