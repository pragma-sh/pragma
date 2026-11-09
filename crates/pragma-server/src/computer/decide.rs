//! Long-lived, timeout-bounded System 1 sidecar used by one computer task.
use pragma_constants::{ComputerDecideRequest, ComputerDecision, CONSTANTS};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

/// One task's private decision process. Keys travel on stdin, never argv or logs.
pub struct Decider {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Value>,
    endpoint: Value,
    next_id: u64,
}

impl Decider {
    pub fn start(server_dir: &Path, home: Option<&Path>) -> Result<Self, String> {
        let data_dir = if server_dir
            .file_name()
            .is_some_and(|name| name == pragma_protocol::PROD_CHANNEL)
        {
            server_dir.parent().unwrap_or(server_dir)
        } else {
            server_dir
        };
        let key = std::fs::read_to_string(data_dir.join(&CONSTANTS.system1.credential_file_name))
            .ok()
            .filter(|key| !key.trim().is_empty())
            .ok_or("Add a System 1 key in Settings before running a computer task")?;
        let settings = home
            .and_then(|home| {
                std::fs::read_to_string(home.join(&CONSTANTS.plugins.config_file_name)).ok()
            })
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_default();
        let system1 = &settings["system1"];
        let base_url = system1["baseUrl"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&CONSTANTS.system1.default_base_url);
        let host = base_url
            .split("://")
            .nth(1)
            .and_then(|s| s.split('/').next())
            .unwrap_or("");
        let model = system1["model"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                CONSTANTS
                    .system1
                    .host_models
                    .iter()
                    .find(|entry| host == entry.host || host.ends_with(&format!(".{}", entry.host)))
                    .map(|entry| entry.model.as_str())
            })
            .unwrap_or(&CONSTANTS.system1.default_model);
        let mut child =
            crate::sidecar::sidecar_command("pragma-ai", "packages/ai-helpers/src/cli.ts")
                .arg("computer-decide")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "Could not start computer decision helper")?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Computer decision stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Computer decision stdout unavailable")?;
        let (tx, replies) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str(&line) {
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            replies,
            next_id: 0,
            endpoint: json!({ "baseUrl": base_url, "model": model, "apiKey": key.trim(), "evaluatePath": CONSTANTS.system1.evaluate_path }),
        })
    }

    pub fn decide(
        &mut self,
        request: &ComputerDecideRequest,
        timeout: Duration,
        cancelled: impl Fn() -> bool,
    ) -> Result<ComputerDecision, String> {
        self.next_id += 1;
        let payload = json!({ "id": self.next_id, "request": request, "endpoint": self.endpoint });
        writeln!(self.stdin, "{payload}")
            .and_then(|()| self.stdin.flush())
            .map_err(|_| "Computer decision helper disconnected")?;
        let started = std::time::Instant::now();
        let timeout = timeout.min(Duration::from_millis(
            CONSTANTS.system1.request_timeout_ms.get() + 2000,
        ));
        let reply = loop {
            if cancelled() || started.elapsed() >= timeout {
                return Err("Computer decision cancelled or timed out".to_string());
            }
            match self.replies.recv_timeout(
                Duration::from_millis(50).min(timeout.saturating_sub(started.elapsed())),
            ) {
                Ok(reply) => break reply,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Computer decision helper disconnected".to_string())
                }
            }
        };
        if reply["id"].as_u64() != Some(self.next_id) {
            return Err("Computer decision correlation failed".to_string());
        }
        serde_json::from_value(reply["decision"].clone())
            .map_err(|_| "Computer decision failed".to_string())
    }
}

impl Drop for Decider {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
