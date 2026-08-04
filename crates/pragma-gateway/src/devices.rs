use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use pragma_platform::perms;
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
    /// Expo push token this installation registered, or `None` when it has not
    /// asked for notifications (or revoked them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_token: Option<String>,
    /// When the current push token was registered, in epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_registered_at: Option<u64>,
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
        let Some(id) = request_header(request, &headers.id).filter(|value| is_valid_id(value))
        else {
            return Ok(());
        };
        let now = now_ms();
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
        let existing = devices.get(id);
        let first_seen_at = existing.map_or(now, |device| device.first_seen_at);
        // Metadata is rewritten from headers on every request; the push
        // registration is not carried in headers, so copy it forward or a single
        // request would silently unsubscribe the phone.
        let push_token = existing.and_then(|device| device.push_token.clone());
        let push_registered_at = existing.and_then(|device| device.push_registered_at);
        devices.insert(
            id.to_string(),
            GatewayDevice {
                id: id.to_string(),
                name,
                platform,
                app_version,
                first_seen_at,
                last_seen_at: now,
                push_token,
                push_registered_at,
            },
        );
        write_devices(&self.path, &devices)
    }

    /// Lists every known device, newest contact first.
    pub fn list(&self) -> Vec<GatewayDevice> {
        let mut devices: Vec<GatewayDevice> = read_devices(&self.path).into_values().collect();
        devices.sort_by_key(|device| std::cmp::Reverse(device.last_seen_at));
        devices
    }

    /// Stores (or replaces) one device's Expo push token.
    ///
    /// Registering a token that another installation already holds clears it
    /// there: Expo reissues a token to whichever install currently owns the
    /// device, and leaving the stale owner in place would double-send.
    pub fn set_push_token(&self, device_id: &str, token: &str) -> GatewayResult<()> {
        let mut devices = read_devices(&self.path);
        for device in devices.values_mut() {
            if device.id != device_id && device.push_token.as_deref() == Some(token) {
                device.push_token = None;
                device.push_registered_at = None;
            }
        }
        let now = now_ms();
        let device = devices
            .entry(device_id.to_string())
            .or_insert_with(|| GatewayDevice {
                id: device_id.to_string(),
                name: "Mobile device".to_string(),
                platform: "unknown".to_string(),
                app_version: "unknown".to_string(),
                first_seen_at: now,
                last_seen_at: now,
                push_token: None,
                push_registered_at: None,
            });
        device.push_token = Some(token.to_string());
        device.push_registered_at = Some(now);
        write_devices(&self.path, &devices)
    }

    /// Stops push delivery to one device, keeping the rest of its record.
    pub fn clear_push_token(&self, device_id: &str) -> GatewayResult<()> {
        let mut devices = read_devices(&self.path);
        let Some(device) = devices.get_mut(device_id) else {
            return Ok(());
        };
        device.push_token = None;
        device.push_registered_at = None;
        write_devices(&self.path, &devices)
    }

    /// Drops a token Expo has rejected as permanently undeliverable.
    pub fn forget_push_token(&self, token: &str) -> GatewayResult<()> {
        let mut devices = read_devices(&self.path);
        let mut changed = false;
        for device in devices.values_mut() {
            if device.push_token.as_deref() == Some(token) {
                device.push_token = None;
                device.push_registered_at = None;
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        write_devices(&self.path, &devices)
    }

    /// Every push token currently registered on this host.
    pub fn push_tokens(&self) -> Vec<String> {
        read_devices(&self.path)
            .into_values()
            .filter_map(|device| device.push_token)
            .collect()
    }
}

/// Milliseconds since the Unix epoch, saturating rather than panicking.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Reads the installation id an authenticated mobile client sends, when it sent
/// a well-formed one. Push registration is keyed by it.
#[must_use]
pub fn device_id(request: &Request) -> Option<String> {
    let headers = &pragma_constants::CONSTANTS.gateway.device_headers;
    request_header(request, &headers.id)
        .filter(|value| is_valid_id(value))
        .map(str::to_string)
}

/// Bounded, path-safe device ids only — the id is used as a registry map key.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
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
    let mut file = perms::create_private_file(&temp_path)?;
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

    use super::{read_devices, write_devices, DeviceRegistry, GatewayDevice};

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
            push_token: None,
            push_registered_at: None,
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

    fn registry() -> (tempfile::TempDir, DeviceRegistry) {
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = DeviceRegistry::new(dir.path().join("gateway-devices.json"));
        (dir, registry)
    }

    #[test]
    fn push_tokens_register_and_unregister() {
        let (_dir, registry) = registry();

        registry
            .set_push_token("device-1", "ExponentPushToken[a]")
            .expect("register");
        assert_eq!(
            registry.push_tokens(),
            vec!["ExponentPushToken[a]".to_string()]
        );

        registry.clear_push_token("device-1").expect("unregister");
        assert!(registry.push_tokens().is_empty());
    }

    #[test]
    fn a_reissued_token_moves_to_its_new_owner() {
        let (_dir, registry) = registry();
        registry
            .set_push_token("device-1", "ExponentPushToken[a]")
            .expect("register first");

        registry
            .set_push_token("device-2", "ExponentPushToken[a]")
            .expect("register second");

        assert_eq!(
            registry.push_tokens(),
            vec!["ExponentPushToken[a]".to_string()]
        );
        let owner = registry
            .list()
            .into_iter()
            .find(|device| device.push_token.is_some())
            .expect("an owner");
        assert_eq!(owner.id, "device-2");
    }

    #[test]
    fn a_dead_token_is_forgotten_everywhere() {
        let (_dir, registry) = registry();
        registry
            .set_push_token("device-1", "ExponentPushToken[a]")
            .expect("register");

        registry
            .forget_push_token("ExponentPushToken[a]")
            .expect("forget");

        assert!(registry.push_tokens().is_empty());
        assert_eq!(registry.list().len(), 1, "the device itself is kept");
    }
}
