use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::Duration;

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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(discovery)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(&json)?;
    file.flush()?;
    Ok(())
}

/// Removes stale discovery data or rejects an already-live gateway.
pub fn remove_stale_or_refuse(path: &Path) -> GatewayResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let discovery = read_discovery(path)?;
    if health_probe(discovery.port) {
        return Err(GatewayError::Http(format!(
            "gateway already running on port {}",
            discovery.port
        )));
    }
    fs::remove_file(path)?;
    Ok(())
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

    use tempfile::tempdir;

    use super::{read_discovery, verify_bearer, write_discovery, GatewayDiscovery};

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
        let mode = fs::metadata(path).expect("metadata").permissions();
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
            0o600
        );
    }
}
