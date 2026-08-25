//! Desktop auto-update check, download, and apply.
//!
//! The Next.js site owns the check API. This module asks it whether a shipped
//! component is behind, downloads the named asset, and either records a UI
//! overlay version (`reload`) or launches the OS installer (`restart`).

use std::fmt::Write as _;
use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use std::{collections::HashMap, env};

use minisign::{PublicKeyBox, SignatureBox};
use pragma_constants::CONSTANTS;
use pragma_protocol::PROD_CHANNEL;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{http, AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::pty;

const UPDATE_PUBLIC_KEY: &str = match option_env!("PRAGMA_UPDATE_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_signature: Option<String>,
}

/// Downloadable file named by the check API.
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub url: String,
    pub sha256: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u8,
    apply: String,
    notes: String,
    changelog_url: String,
    components: HashMap<String, String>,
    assets: HashMap<String, UpdateAsset>,
}

/// Payload the UI sends to apply a previously-checked offer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub apply: String,
    pub version: String,
    pub asset: UpdateAsset,
    pub manifest_json: String,
    pub manifest_signature: String,
}

/// Outcome of [`apply_update`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Confirms the newly loaded overlay rendered far enough to mount the app.
#[tauri::command(async)]
pub fn confirm_ui_overlay(app: AppHandle) -> AppResult<()> {
    let loaded_from_overlay = app
        .get_webview_window("main")
        .and_then(|window| window.url().ok())
        .is_some_and(|url| {
            url.scheme() == "pragma-ui"
                || (url.scheme() == "http" && url.host_str() == Some("pragma-ui.localhost"))
        });
    if loaded_from_overlay && active_overlay_version(&app)?.is_some() {
        let pending = overlay_pending_path(&app)?;
        if pending.exists() {
            fs::remove_file(pending)?;
        }
    }
    Ok(())
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
    if os == "linux" {
        return format!("{os}-{arch}-{}", linux_package_format());
    }
    format!("{os}-{arch}")
}

fn linux_package_format() -> &'static str {
    if env::var_os("APPIMAGE").is_some() {
        return "appimage";
    }
    fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|contents| linux_package_format_from_os_release(&contents))
        .unwrap_or("appimage")
}

fn linux_package_format_from_os_release(contents: &str) -> Option<&'static str> {
    let identifiers = contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| matches!(*key, "ID" | "ID_LIKE"))
        .flat_map(|(_, value)| {
            value
                .split(|character: char| !character.is_ascii_alphanumeric())
                .filter(|part| !part.is_empty())
        });
    for identifier in identifiers {
        match identifier.to_ascii_lowercase().as_str() {
            "debian" | "ubuntu" => return Some("deb"),
            "fedora" | "rhel" | "centos" | "suse" | "opensuse" => return Some("rpm"),
            _ => {}
        }
    }
    None
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
        .unwrap_or_else(|| runtime.check_url.clone());
    let url = format!(
        "{base}{sep}platform={platform}&ui={ui}&app={app}&server={server}&protocol={protocol}",
        sep = if base.contains('?') { "&" } else { "?" },
        platform = urlencoding_lite(&runtime.platform),
        ui = urlencoding_lite(&runtime.versions.ui),
        app = urlencoding_lite(&runtime.versions.app),
        server = urlencoding_lite(&runtime.versions.server),
        protocol = urlencoding_lite(&runtime.versions.protocol),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let check = fetch_json::<UpdateCheck>(&url)?;
        if check.available {
            validate_checked_offer(&runtime, &check)?;
        }
        Ok(check)
    })
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
    let runtime = get_update_runtime(app.clone())?;
    validate_offer(
        &runtime,
        &request.apply,
        &request.version,
        &request.asset,
        &request.manifest_json,
        &request.manifest_signature,
    )?;
    let bytes = download_asset(app, &request.asset)?;
    match request.apply.as_str() {
        "reload" => {
            install_ui_overlay(app, &request.version, &bytes)?;
            Ok(ApplyResult {
                mode: "reload".to_string(),
                url: Some(ui_overlay_url()),
            })
        }
        "restart" => {
            let path = installer_path(app, &request.version, &request.asset.url)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, bytes)?;
            opener::open(&path).map_err(|error| AppError::Update(error.to_string()))?;
            Ok(ApplyResult {
                mode: "restart".to_string(),
                url: None,
            })
        }
        other => Err(AppError::Update(format!("unknown apply mode: {other}"))),
    }
}

fn validate_checked_offer(runtime: &UpdateRuntime, check: &UpdateCheck) -> AppResult<()> {
    let apply = check
        .apply
        .as_deref()
        .ok_or_else(|| AppError::Update("update apply mode is missing".to_string()))?;
    let version = check
        .version
        .as_deref()
        .ok_or_else(|| AppError::Update("update version is missing".to_string()))?;
    let asset = check
        .asset
        .as_ref()
        .ok_or_else(|| AppError::Update("update asset is missing".to_string()))?;
    let manifest_json = check
        .manifest_json
        .as_deref()
        .ok_or_else(|| AppError::Update("signed update manifest is missing".to_string()))?;
    let manifest_signature = check
        .manifest_signature
        .as_deref()
        .ok_or_else(|| AppError::Update("update manifest signature is missing".to_string()))?;
    let manifest = validate_offer(
        runtime,
        apply,
        version,
        asset,
        manifest_json,
        manifest_signature,
    )?;
    if check.notes.as_deref() != Some(manifest.notes.as_str())
        || check.changelog_url.as_deref() != Some(manifest.changelog_url.as_str())
    {
        return Err(AppError::Update(
            "update metadata does not match signed manifest".to_string(),
        ));
    }
    Ok(())
}

fn validate_offer(
    runtime: &UpdateRuntime,
    apply: &str,
    version: &str,
    asset: &UpdateAsset,
    manifest_json: &str,
    manifest_signature: &str,
) -> AppResult<ReleaseManifest> {
    validate_offer_with_key(
        runtime,
        apply,
        version,
        asset,
        manifest_json,
        manifest_signature,
        UPDATE_PUBLIC_KEY,
    )
}

fn validate_offer_with_key(
    runtime: &UpdateRuntime,
    apply: &str,
    version: &str,
    asset: &UpdateAsset,
    manifest_json: &str,
    manifest_signature: &str,
    public_key: &str,
) -> AppResult<ReleaseManifest> {
    let parsed_version = Version::parse(version)
        .map_err(|error| AppError::Update(format!("invalid update version: {error}")))?;
    if !(runtime.is_dev && manifest_signature.is_empty()) {
        verify_asset_signature(public_key, manifest_signature, manifest_json.as_bytes())?;
    }
    let manifest: ReleaseManifest = serde_json::from_str(manifest_json)
        .map_err(|error| AppError::Update(format!("invalid signed update manifest: {error}")))?;
    if manifest.schema_version != 1 {
        return Err(AppError::Update(
            "unsupported update manifest schema".to_string(),
        ));
    }
    let component = if apply == "reload" { "ui" } else { "app" };
    let asset_key = if apply == "reload" {
        "ui"
    } else {
        runtime.platform.as_str()
    };
    let signed_version = manifest.components.get(component);
    let signed_asset = manifest.assets.get(asset_key);
    let dev_fixture = runtime.is_dev && manifest_signature.is_empty();
    if manifest.apply != apply
        || signed_version.map(String::as_str) != Some(version)
        || (!dev_fixture && signed_asset != Some(asset))
    {
        return Err(AppError::Update(
            "update offer does not match signed manifest".to_string(),
        ));
    }
    let current = if apply == "reload" {
        &runtime.versions.ui
    } else {
        &runtime.versions.app
    };
    let current = Version::parse(current)
        .map_err(|error| AppError::Update(format!("invalid running version: {error}")))?;
    if parsed_version <= current {
        return Err(AppError::Update(
            "update version is not newer than running version".to_string(),
        ));
    }
    if apply == "reload"
        && [
            ("app", &runtime.versions.app),
            ("pragma-server", &runtime.versions.server),
            ("pragma-protocol", &runtime.versions.protocol),
        ]
        .into_iter()
        .any(|(component, running)| component_is_newer(&manifest, component, running))
    {
        return Err(AppError::Update(
            "UI update requires a newer native installer".to_string(),
        ));
    }
    Ok(manifest)
}

fn component_is_newer(manifest: &ReleaseManifest, component: &str, running: &str) -> bool {
    let Some(released) = manifest.components.get(component) else {
        return false;
    };
    match (Version::parse(released), Version::parse(running)) {
        (Ok(released), Ok(running)) => released > running,
        _ => false,
    }
}

fn running_versions(app: &AppHandle) -> AppResult<UpdateVersions> {
    let bundled = CONSTANTS.app.version.clone();
    let ui = active_overlay_version(app)?.unwrap_or_else(|| bundled.clone());
    Ok(UpdateVersions {
        ui,
        app: bundled.clone(),
        server: bundled,
        protocol: CONSTANTS.daemon.protocol_version.clone(),
    })
}

fn active_overlay_version(app: &AppHandle) -> AppResult<Option<String>> {
    let Some(overlay) = overlay_version(app)? else {
        return Ok(None);
    };
    let bundled = Version::parse(&CONSTANTS.app.version)
        .map_err(|error| AppError::Update(format!("invalid bundled version: {error}")))?;
    let installed = Version::parse(&overlay)
        .map_err(|error| AppError::Update(format!("invalid UI overlay version: {error}")))?;
    if installed > bundled {
        return Ok(Some(overlay));
    }
    let root = overlay_dir(app)?;
    if root.exists() {
        fs::remove_dir_all(root)?;
    }
    Ok(None)
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

fn install_ui_overlay(app: &AppHandle, version: &str, bytes: &[u8]) -> AppResult<()> {
    let root = overlay_dir(app)?;
    let staging = root.with_extension("staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    unpack_ui_archive(bytes, &staging)?;
    if !staging.join("index.html").is_file() {
        return Err(AppError::Update("UI archive has no index.html".to_string()));
    }
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    fs::rename(staging, &root)?;
    write_overlay_version(app, version)?;
    fs::write(overlay_pending_path(app)?, b"pending\n")?;
    Ok(())
}

fn unpack_ui_archive(bytes: &[u8], destination: &Path) -> AppResult<()> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(AppError::Update(
                "UI archive contains a non-file entry".to_string(),
            ));
        }
        if !entry.unpack_in(destination)? {
            return Err(AppError::Update(
                "UI archive path escapes its destination".to_string(),
            ));
        }
    }
    Ok(())
}

fn overlay_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(instance_root(app)?.join(CONSTANTS.updates.ui_dir_name.as_str()))
}

fn overlay_pending_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(overlay_dir(app)?.join(".pending"))
}

/// URL the main webview uses for an installed UI overlay.
#[must_use]
pub fn ui_overlay_url() -> String {
    if cfg!(target_os = "windows") {
        "http://pragma-ui.localhost/index.html".to_string()
    } else {
        "pragma-ui://localhost/index.html".to_string()
    }
}

/// Navigates the main webview to a previously installed overlay at startup.
pub fn load_ui_overlay(app: &AppHandle) {
    if overlay_pending_path(app).is_ok_and(|path| path.exists()) {
        if let Ok(root) = overlay_dir(app) {
            if let Err(error) = fs::remove_dir_all(root) {
                log::warn!("failed to roll back unconfirmed UI overlay: {error}");
            }
        }
        return;
    }
    let Ok(Some(_)) = active_overlay_version(app) else {
        return;
    };
    let Ok(root) = overlay_dir(app) else {
        return;
    };
    if !root.join("index.html").is_file() {
        return;
    }
    let Ok(url) = tauri::Url::parse(&ui_overlay_url()) else {
        log::warn!("invalid UI overlay URL");
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.navigate(url) {
            log::warn!("failed to load UI overlay: {error}");
        }
    }
}

/// Serves one file from the active UI overlay without exposing arbitrary app data.
pub fn ui_overlay_response(app: &AppHandle, request_path: &str) -> http::Response<Vec<u8>> {
    let relative = request_path.trim_start_matches('/');
    let path = Path::new(relative);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return response(http::StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    }
    let Ok(root) = overlay_dir(app) else {
        return response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let requested = root.join(path);
    let file = if requested.is_file() {
        requested
    } else if path.extension().is_none() {
        root.join("index.html")
    } else {
        return response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    match fs::read(&file) {
        Ok(bytes) => response(http::StatusCode::OK, content_type(&file), bytes),
        Err(_) => response(http::StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

fn response(
    status: http::StatusCode,
    content_type: &str,
    bytes: Vec<u8>,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::CACHE_CONTROL, "no-cache")
        .body(bytes)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn installer_path(app: &AppHandle, version: &str, asset_url: &str) -> AppResult<PathBuf> {
    let suffix = [".AppImage", ".dmg", ".exe", ".msi", ".deb", ".rpm"]
        .into_iter()
        .find(|suffix| {
            asset_url
                .split(['?', '#'])
                .next()
                .is_some_and(|url| url.ends_with(suffix))
        })
        .unwrap_or_default();
    Ok(instance_root(app)?
        .join("updates")
        .join(format!("Pragma-{version}{suffix}")))
}

fn instance_root(app: &AppHandle) -> AppResult<PathBuf> {
    let app_data = app.path().app_data_dir()?;
    let channel = pty::instance_channel(app.config().product_name.as_deref());
    Ok(pty::instance_data_dir(&app_data, &channel))
}

fn download_asset(app: &AppHandle, asset: &UpdateAsset) -> AppResult<Vec<u8>> {
    let bytes = fetch_bytes(&asset.url)?;
    let digest = sha256_hex(&bytes);
    if digest != asset.sha256 {
        return Err(AppError::Update(format!(
            "sha256 mismatch: expected {}, got {digest}",
            asset.sha256
        )));
    }
    let is_dev = pty::instance_channel(app.config().product_name.as_deref()) != PROD_CHANNEL;
    if !(is_dev && asset.signature.is_empty()) {
        verify_asset_signature(UPDATE_PUBLIC_KEY, &asset.signature, &bytes)?;
    }
    Ok(bytes)
}

fn verify_asset_signature(public_key: &str, signature: &str, bytes: &[u8]) -> AppResult<()> {
    if public_key.is_empty() {
        return Err(AppError::Update(
            "update signing public key is missing".to_string(),
        ));
    }
    let key = PublicKeyBox::from_string(public_key)
        .and_then(PublicKeyBox::into_public_key)
        .map_err(|error| AppError::Update(format!("invalid update public key: {error}")))?;
    let signature = SignatureBox::from_string(signature)
        .map_err(|error| AppError::Update(format!("invalid update signature: {error}")))?;
    minisign::verify(&key, &signature, Cursor::new(bytes), true, false, false)
        .map_err(|error| AppError::Update(format!("update signature verification failed: {error}")))
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
    use std::fs;
    use std::io::Cursor;

    use minisign::KeyPair;

    use super::{
        linux_package_format_from_os_release, sha256_hex, unpack_ui_archive, update_platform,
        urlencoding_lite, validate_offer_with_key, verify_asset_signature, UpdateAsset,
        UpdateRuntime, UpdateVersions,
    };

    #[test]
    fn platform_id_has_os_and_arch() {
        let platform = update_platform();
        assert!(platform.contains('-'), "expected os-arch, got {platform}");
    }

    #[test]
    fn detects_linux_package_family() {
        assert_eq!(
            linux_package_format_from_os_release("ID=pop\nID_LIKE=\"ubuntu debian\"\n"),
            Some("deb")
        );
        assert_eq!(
            linux_package_format_from_os_release("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n"),
            Some("rpm")
        );
        assert_eq!(linux_package_format_from_os_release("ID=arch\n"), None);
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

    #[test]
    fn unpacks_ui_archive() {
        let mut bytes = Vec::new();
        {
            let mut archive = tar::Builder::new(&mut bytes);
            let contents = b"<main>Pragma</main>";
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, "index.html", &contents[..])
                .expect("append index");
            archive.finish().expect("finish archive");
        }
        let directory = tempfile::tempdir().expect("tempdir");
        unpack_ui_archive(&bytes, directory.path()).expect("unpack archive");
        assert_eq!(
            fs::read(directory.path().join("index.html")).expect("read index"),
            b"<main>Pragma</main>"
        );
    }

    #[test]
    fn verifies_update_signature() {
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().expect("keypair");
        let bytes = b"signed update";
        let signature = minisign::sign(None, &sk, Cursor::new(bytes), None, None)
            .expect("sign")
            .into_string();
        let public_key = pk.to_box().expect("public key box").to_string();
        verify_asset_signature(&public_key, &signature, bytes).expect("valid signature");
        assert!(verify_asset_signature(&public_key, &signature, b"tampered").is_err());
    }

    #[test]
    fn signed_manifest_binds_offer_metadata() {
        let asset = UpdateAsset {
            url: "https://example.com/ui.tar".to_string(),
            sha256: "abc".to_string(),
            signature: "asset-signature".to_string(),
        };
        let manifest_json = format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 1,
                "apply": "reload",
                "notes": "notes",
                "changelogUrl": "https://example.com/changelog",
                "components": {
                    "ui": "0.0.1",
                    "app": "0.0.0",
                    "pragma-server": "0.0.0",
                    "pragma-protocol": "0.0.0"
                },
                "assets": { "ui": asset.clone() }
            })
        );
        let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair().expect("keypair");
        let signature =
            minisign::sign(None, &sk, Cursor::new(manifest_json.as_bytes()), None, None)
                .expect("sign")
                .into_string();
        let public_key = pk.to_box().expect("public key box").to_string();
        let runtime = UpdateRuntime {
            platform: "darwin-aarch64".to_string(),
            is_dev: false,
            check_url: String::new(),
            versions: UpdateVersions {
                ui: "0.0.0".to_string(),
                app: "0.0.0".to_string(),
                server: "0.0.0".to_string(),
                protocol: "0.0.0".to_string(),
            },
        };

        validate_offer_with_key(
            &runtime,
            "reload",
            "0.0.1",
            &asset,
            &manifest_json,
            &signature,
            &public_key,
        )
        .expect("signed offer");
        assert!(validate_offer_with_key(
            &runtime,
            "reload",
            "9.0.0",
            &asset,
            &manifest_json,
            &signature,
            &public_key,
        )
        .is_err());
    }
}
