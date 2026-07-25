use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use pragma_platform::{perms, process};
use rand::distributions::{Alphanumeric, DistString};
use serde::{Deserialize, Serialize};

use crate::error::{GatewayError, GatewayResult};

/// Discovery metadata written beside `daemon.sock`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDiscovery {
    /// Localhost HTTP port.
    pub port: u16,
    /// Bearer token.
    pub token: String,
    /// Gateway process id.
    pub pid: u32,
    /// Pragma server protocol version this gateway expects.
    pub protocol_version: u64,
}

/// Generates a random bearer token.
#[must_use]
pub fn generate_token() -> String {
    Alphanumeric.sample_string(&mut rand::thread_rng(), 48)
}

/// Reads the persistent bearer token beside the socket, generating and writing
/// it `0600` on first use so the token survives gateway restarts and stays
/// stable across paired devices until explicitly regenerated.
pub fn read_or_create_token(path: &Path) -> GatewayResult<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let token = generate_token();
    write_token(path, &token)?;
    Ok(token)
}

/// Writes the persistent bearer token with owner-only permissions.
pub fn write_token(path: &Path, token: &str) -> GatewayResult<()> {
    let mut file = perms::create_private_file(path)?;
    file.write_all(token.as_bytes())?;
    file.flush()?;
    Ok(())
}

/// Constant-time-ish token verification for equal-length strings.
#[must_use]
pub fn verify_bearer(expected: &str, header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(expected.as_bytes(), token.as_bytes())
}

/// Reads a discovery file.
pub fn read_discovery(path: &Path) -> GatewayResult<GatewayDiscovery> {
    let contents = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents)?)
}

/// Writes a discovery file with owner-only permissions.
pub fn write_discovery(path: &Path, discovery: &GatewayDiscovery) -> GatewayResult<()> {
    let json = serde_json::to_vec_pretty(discovery)?;
    let mut file = perms::create_private_file(path)?;
    file.write_all(&json)?;
    file.flush()?;
    Ok(())
}

/// Removes stale discovery data or rejects an already-live gateway.
///
/// A live gateway that advertises a *different* protocol version can never
/// serve this app again (clients reject the mismatched discovery file), so it
/// is terminated and replaced instead of refused — otherwise a leftover
/// gateway from a previous app version deadlocks every future gateway start.
pub fn remove_stale_or_refuse(path: &Path, protocol_version: u64) -> GatewayResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let Ok(discovery) = read_discovery(path) else {
        // Unreadable discovery data cannot identify a live gateway; treat as stale.
        fs::remove_file(path)?;
        return Ok(());
    };
    if health_probe(discovery.port) {
        if discovery.protocol_version == protocol_version {
            return Err(GatewayError::Http(format!(
                "gateway already running on port {}",
                discovery.port
            )));
        }
        kill_stale_gateway(discovery.pid);
    }
    fs::remove_file(path)?;
    Ok(())
}

/// Kills a superseded gateway process, but only after confirming the pid still
/// belongs to a `pragma-gateway` binary (pids get recycled).
fn kill_stale_gateway(pid: u32) {
    if process::is_running(pid, "pragma-gateway") {
        let _ = process::kill(pid);
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .iter()
        .zip(right)
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right));
    diff == 0
}

fn health_probe(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use tempfile::tempdir;

    use super::{
        read_discovery, read_or_create_token, remove_stale_or_refuse, verify_bearer,
        write_discovery, GatewayDiscovery,
    };

    /// Serves one `/v1/health` 200 response on an ephemeral port, mimicking a
    /// live gateway for the health probe.
    fn fake_live_gateway() -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            }
        });
        (port, handle)
    }

    fn discovery(port: u16, protocol_version: u64) -> GatewayDiscovery {
        GatewayDiscovery {
            port,
            // A pid that is never a live pragma-gateway, so the takeover path
            // skips the kill while still exercising file removal.
            pid: u32::MAX,
            token: "token".to_string(),
            protocol_version,
        }
    }

    #[test]
    fn refuses_when_a_same_protocol_gateway_is_live() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway.json");
        let (port, handle) = fake_live_gateway();
        write_discovery(&path, &discovery(port, 11)).expect("write discovery");

        let result = remove_stale_or_refuse(&path, 11);

        handle.join().expect("responder");
        assert!(result.is_err());
        assert!(path.exists());
    }

    #[test]
    fn takes_over_from_a_live_gateway_with_a_different_protocol() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway.json");
        let (port, handle) = fake_live_gateway();
        write_discovery(&path, &discovery(port, 9)).expect("write discovery");

        remove_stale_or_refuse(&path, 11).expect("takeover");

        handle.join().expect("responder");
        assert!(!path.exists());
    }

    #[test]
    fn removes_a_dead_gateway_discovery_file() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway.json");
        // Bind then drop so the port is (almost certainly) unbound.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        write_discovery(&path, &discovery(port, 11)).expect("write discovery");

        remove_stale_or_refuse(&path, 11).expect("stale removal");

        assert!(!path.exists());
    }

    #[test]
    fn removes_an_unreadable_discovery_file() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway.json");
        fs::write(&path, "not json").expect("write");

        remove_stale_or_refuse(&path, 11).expect("corrupt removal");

        assert!(!path.exists());
    }

    #[test]
    fn read_or_create_token_persists_and_reuses() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway-token");

        let first = read_or_create_token(&path).expect("create token");
        assert!(!first.is_empty());
        let second = read_or_create_token(&path).expect("reuse token");
        assert_eq!(first, second, "token must survive across reads");

        #[cfg(unix)]
        {
            let mode = fs::metadata(&path).expect("metadata").permissions();
            assert_eq!(
                std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn verifies_bearer_tokens() {
        assert!(verify_bearer("secret", Some("Bearer secret")));
        assert!(!verify_bearer("secret", Some("Bearer nope")));
        assert!(!verify_bearer("secret", None));
    }

    #[test]
    fn discovery_round_trips() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("gateway.json");
        let discovery = GatewayDiscovery {
            port: 1234,
            token: "token".to_string(),
            pid: 42,
            protocol_version: 8,
        };
        write_discovery(&path, &discovery).expect("write discovery");
        assert_eq!(read_discovery(&path).expect("read discovery"), discovery);
        #[cfg(unix)]
        {
            let mode = fs::metadata(path).expect("metadata").permissions();
            assert_eq!(
                std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
                0o600
            );
        }
    }
}
