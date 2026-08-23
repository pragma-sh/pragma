//! Desktop auto-update check, download, and apply.
//!
//! The Next.js site owns the check API. This module asks it whether a shipped
//! component is behind, downloads the named asset, and either records a UI
//! overlay version (`reload`) or launches the OS installer (`restart`).

use std::fmt::Write as _;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use pragma_constants::CONSTANTS;
use pragma_protocol::PROD_CHANNEL;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::pty;

/// Running versions plus the platform/check-url defaults for this instance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntime {
    /// Installer target id (`darwin-aarch64`, …).
    pub platform: String,
    /// True when this is a `pragma-dev-*` instance (must not poll production).
    pub is_dev: bool,
    /// Shipped check URL for this instance (settings may override).
    pub check_url: String,
    /// Versions the check API compares against the manifest.
    pub versions: UpdateVersions,
}

/// Shipped-into-the-app versions this process reports on a check.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVersions {
    pub ui: String,
    pub app: String,
    pub server: String,
    pub protocol: String,
}

/// Body of `GET /api/updates`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<UpdateAsset>,
}

/// Downloadable file named by the check API.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub url: String,
    pub sha256: String,
    pub signature: String,
}

/// Payload the UI sends to apply a previously-checked offer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub apply: String,
    pub version: String,
    pub asset: UpdateAsset,
}

/// Outcome of [`apply_update`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub mode: String,
}

/// Returns the constants platform id for this OS/arch.
#[must_use]
pub fn update_platform() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    format!("{os}-{arch}")
}

/// Runtime identity the Settings page and poller share.
#[tauri::command(async)]
pub fn get_update_runtime(app: AppHandle) -> AppResult<UpdateRuntime> {
    let is_dev = pty::instance_channel(app.config().product_name.as_deref()) != PROD_CHANNEL;
    let check_url = if is_dev {
        CONSTANTS.updates.dev_check_url.clone()
    } else {
        CONSTANTS.updates.check_url.clone()
    };
    Ok(UpdateRuntime {
        platform: update_platform(),
        is_dev,
        check_url,
        versions: running_versions(&app)?,
    })
}

/// Polls the check API with this instance's platform and versions.
#[tauri::command(async)]
pub async fn check_for_update(app: AppHandle, check_url: Option<String>) -> AppResult<UpdateCheck> {
    let runtime = get_update_runtime(app)?;
    let base = check_url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(runtime.check_url);
    let url = format!(
        "{base}{sep}platform={platform}&ui={ui}&app={app}&server={server}&protocol={protocol}",
        sep = if base.contains('?') { "&" } else { "?" },
        platform = urlencoding_lite(&runtime.platform),
        ui = urlencoding_lite(&runtime.versions.ui),
        app = urlencoding_lite(&runtime.versions.app),
        server = urlencoding_lite(&runtime.versions.server),
        protocol = urlencoding_lite(&runtime.versions.protocol),
    );
    tauri::async_runtime::spawn_blocking(move || fetch_json::<UpdateCheck>(&url))
        .await
        .map_err(|error| AppError::Update(error.to_string()))?
}

/// Downloads the offer (when needed) and applies reload vs restart.
#[tauri::command(async)]
pub async fn apply_update(app: AppHandle, request: ApplyRequest) -> AppResult<ApplyResult> {
    tauri::async_runtime::spawn_blocking(move || apply_blocking(&app, &request))
        .await
        .map_err(|error| AppError::Update(error.to_string()))?
}

fn apply_blocking(app: &AppHandle, request: &ApplyRequest) -> AppResult<ApplyResult> {
    let bytes = download_asset(&request.asset)?;
    match request.apply.as_str() {
        "reload" => {
            write_overlay_version(app, &request.version)?;
            let overlay_dir = overlay_dir(app)?;
            fs::create_dir_all(&overlay_dir)?;
            let mut file =
                pragma_platform::perms::create_private_file(&overlay_dir.join("payload"))?;
            file.write_all(&bytes)?;
            file.flush()?;
            Ok(ApplyResult {
                mode: "reload".to_string(),
            })
        }
        "restart" => {
            let path = installer_path(app, &request.version)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, bytes)?;
            opener::open(&path).map_err(|error| AppError::Update(error.to_string()))?;
            Ok(ApplyResult {
                mode: "restart".to_string(),
            })
        }
        other => Err(AppError::Update(format!("unknown apply mode: {other}"))),
    }
}

fn running_versions(app: &AppHandle) -> AppResult<UpdateVersions> {
    let bundled = CONSTANTS.app.version.clone();
    let ui = overlay_version(app)?.unwrap_or_else(|| bundled.clone());
    Ok(UpdateVersions {
        ui,
        app: bundled.clone(),
        server: bundled,
        protocol: CONSTANTS.daemon.protocol_version.clone(),
    })
}

fn overlay_version(app: &AppHandle) -> AppResult<Option<String>> {
    let path = overlay_dir(app)?.join("version");
    match fs::read_to_string(path) {
        Ok(contents) => {
            let trimmed = contents.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_overlay_version(app: &AppHandle, version: &str) -> AppResult<()> {
    let dir = overlay_dir(app)?;
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("version"), version)?;
    Ok(())
}

fn overlay_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(instance_root(app)?.join(CONSTANTS.updates.ui_dir_name.as_str()))
}

fn installer_path(app: &AppHandle, version: &str) -> AppResult<PathBuf> {
    Ok(instance_root(app)?
        .join("updates")
        .join(format!("Pragma-{version}")))
}

fn instance_root(app: &AppHandle) -> AppResult<PathBuf> {
    let app_data = app.path().app_data_dir()?;
    let channel = pty::instance_channel(app.config().product_name.as_deref());
    Ok(pty::instance_data_dir(&app_data, &channel))
}

fn download_asset(asset: &UpdateAsset) -> AppResult<Vec<u8>> {
    let bytes = fetch_bytes(&asset.url)?;
    let digest = sha256_hex(&bytes);
    if digest != asset.sha256 {
        return Err(AppError::Update(format!(
            "sha256 mismatch: expected {}, got {digest}",
            asset.sha256
        )));
    }
    Ok(bytes)
}

fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> AppResult<T> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::Update(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| AppError::Update(error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Update(format!(
            "check failed: HTTP {}",
            response.status()
        )));
    }
    response
        .json()
        .map_err(|error| AppError::Update(error.to_string()))
}

fn fetch_bytes(url: &str) -> AppResult<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| AppError::Update(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| AppError::Update(error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Update(format!(
            "download failed: HTTP {}",
            response.status()
        )));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| AppError::Update(error.to_string()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn urlencoding_lite(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => write!(encoded, "%{byte:02X}").expect("writing to String cannot fail"),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{sha256_hex, update_platform, urlencoding_lite};

    #[test]
    fn platform_id_has_os_and_arch() {
        let platform = update_platform();
        assert!(platform.contains('-'), "expected os-arch, got {platform}");
    }

    #[test]
    fn sha256_matches_empty_input() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(urlencoding_lite("0.0.0"), "0.0.0");
        assert_eq!(urlencoding_lite("a b"), "a%20b");
    }
}
