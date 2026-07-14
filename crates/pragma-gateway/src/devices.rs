use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tiny_http::Request;

use crate::error::GatewayResult;

const MAX_DEVICES: usize = 100;

/// One mobile installation that successfully authenticated with this gateway.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
}

/// Persistent registry of authenticated mobile installations.
#[derive(Clone, Debug)]
pub struct DeviceRegistry {
    path: PathBuf,
}

impl DeviceRegistry {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Records device metadata from an authenticated request. Requests without
    /// identity headers remain valid but do not produce anonymous list entries.
    pub fn record(&self, request: &Request) -> GatewayResult<()> {
        let headers = &pragma_constants::CONSTANTS.gateway.device_headers;
        let Some(id) = request_header(request, &headers.id).filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        if id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Ok(());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        let mut devices = read_devices(&self.path);
        let name = bounded_header(request, &headers.name, "Mobile device");
        let platform = bounded_header(request, &headers.platform, "unknown");
        let app_version = bounded_header(request, &headers.app_version, "unknown");
        if let Some(existing) = devices.get(id) {
            let unchanged = existing.name == name
                && existing.platform == platform
                && existing.app_version == app_version;
            if unchanged && now.saturating_sub(existing.last_seen_at) < 30_000 {
                return Ok(());
            }
        } else if devices.len() >= MAX_DEVICES {
            if let Some(oldest) = devices
                .values()
                .min_by_key(|device| device.last_seen_at)
                .map(|device| device.id.clone())
            {
                devices.remove(&oldest);
            }
        }
        let first_seen_at = devices.get(id).map_or(now, |device| device.first_seen_at);
        devices.insert(
            id.to_string(),
            GatewayDevice {
                id: id.to_string(),
                name,
                platform,
                app_version,
                first_seen_at,
                last_seen_at: now,
            },
        );
        write_devices(&self.path, &devices)
    }
}

fn bounded_header(request: &Request, field: &str, fallback: &str) -> String {
    request_header(request, field)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .chars()
        .take(128)
        .collect()
}

fn request_header<'a>(request: &'a Request, field: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(field))
        .map(|header| header.value.as_str())
}

fn read_devices(path: &Path) -> BTreeMap<String, GatewayDevice> {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn write_devices(path: &Path, devices: &BTreeMap<String, GatewayDevice>) -> GatewayResult<()> {
    let json = serde_json::to_vec_pretty(devices)?;
    let temp_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp_path)?;
    file.write_all(&json)?;
    file.sync_all()?;
    fs::rename(temp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::{read_devices, write_devices, GatewayDevice};

    #[test]
    fn device_registry_round_trips_atomically_with_owner_only_permissions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("gateway-devices.json");
        let device = GatewayDevice {
            id: "device-1".to_string(),
            name: "Phone".to_string(),
            platform: "ios".to_string(),
            app_version: "1.0.0".to_string(),
            first_seen_at: 10,
            last_seen_at: 20,
        };
        let devices = BTreeMap::from([(device.id.clone(), device)]);

        write_devices(&path, &devices).expect("write devices");

        assert_eq!(read_devices(&path).len(), 1);
        assert_eq!(std::fs::read_dir(dir.path()).expect("read dir").count(), 1);
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
