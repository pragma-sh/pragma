//! Installation and first-run discovery for official npm plugins.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::process_env;
use crate::pty::PtyClient;

const ONBOARDING_DISMISSED_KEY: &str = "plugins.installOnboardingDismissed";
const AGENT_PROMPT_DISMISSED_KEY: &str = "plugins.agentCommandPromptDismissed";
const MAX_COMMAND_OUTPUT_BYTES: usize = 16 * 1024;

/// Serializes global plugin installs and their config read-modify-write cycle.
#[derive(Default)]
pub struct PluginInstaller(Mutex<()>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPluginRequest {
    package: String,
    version: String,
    integrity: String,
    manifest_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPluginResult {
    package: String,
    version: String,
    plugin_id: String,
}

#[derive(Debug, Deserialize)]
struct PackResult {
    filename: String,
    integrity: String,
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    name: String,
    version: String,
    pragma: PragmaPackage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PragmaPackage {
    plugin_id: String,
    main: String,
}

#[derive(Debug, Deserialize)]
struct DistributionManifest {
    install: InstallCommand,
}

#[derive(Debug, Deserialize)]
struct InstallCommand {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct GlobalConfig {
    #[serde(default)]
    plugins: Vec<PluginEntry>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PluginEntry {
    path: String,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

/// Downloads, verifies, installs, and globally registers one exact official plugin release.
#[tauri::command(async)]
pub fn install_official_plugin(
    app: tauri::AppHandle,
    pty: State<'_, PtyClient>,
    installer: State<'_, PluginInstaller>,
    request: InstallPluginRequest,
) -> AppResult<InstallPluginResult> {
    let _guard = installer.0.lock()?;
    validate_request(&request)?;
    let home = app.path().home_dir()?;
    let root = home.join(".pragma").join("plugins").join("npm");
    pragma_platform::perms::create_private_dir(&root)?;
    let staging = root.join(format!(".install-{}", uuid::Uuid::new_v4()));
    pragma_platform::perms::create_private_dir(&staging)?;
    let result = install_into(&request, &home, &root, &staging, &pty);
    if let Err(error) = std::fs::remove_dir_all(&staging) {
        log::warn!("failed to clean plugin install staging dir: {error}");
    }
    result
}

fn install_into(
    request: &InstallPluginRequest,
    home: &Path,
    root: &Path,
    staging: &Path,
    pty: &PtyClient,
) -> AppResult<InstallPluginResult> {
    let specifier = format!("{}@{}", request.package, request.version);
    let pack = run_command(
        "npm",
        &[
            "pack",
            &specifier,
            "--json",
            "--ignore-scripts",
            "--pack-destination",
        ],
        Some(staging),
        Some(staging),
    )?;
    let packed: Vec<PackResult> = serde_json::from_str(&pack)?;
    let packed = packed
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Plugin("npm pack returned no package".to_string()))?;
    if packed.integrity != request.integrity {
        return Err(AppError::Plugin(
            "npm tarball integrity differs from official lock".to_string(),
        ));
    }
    let tarball = staging.join(&packed.filename);
    let install_root = staging.join("package");
    pragma_platform::perms::create_private_dir(&install_root)?;
    let tarball_arg = tarball.to_string_lossy();
    run_command(
        "npm",
        &[
            "install",
            &tarball_arg,
            "--ignore-scripts",
            "--no-save",
            "--no-package-lock",
            "--prefix",
            ".",
        ],
        Some(&install_root),
        None,
    )?;

    let package_dir = installed_package_dir(&install_root, &request.package)?;
    let manifest_text = std::fs::read_to_string(package_dir.join("pragma-plugin.json"))?;
    let manifest_hash = format!("{:x}", Sha256::digest(manifest_text.as_bytes()));
    if manifest_hash != request.manifest_sha256 {
        return Err(AppError::Plugin(
            "installed pragma-plugin.json differs from official lock".to_string(),
        ));
    }
    let manifest: DistributionManifest = serde_json::from_str(&manifest_text)?;
    let package: PackageJson =
        serde_json::from_str(&std::fs::read_to_string(package_dir.join("package.json"))?)?;
    validate_installed_package(request, &package_dir, &package)?;

    let destination = root.join(format!(
        "{}-{}-{}",
        request.package.replace(['@', '/'], "-"),
        request.version,
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(&package_dir, &destination)?;
    if let Err(error) = run_install_command(&destination, &manifest.install) {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error);
    }
    register_global_plugin(home, root, &request.package, &destination)?;
    remove_superseded_installs(root, &request.package, &destination);
    if let Err(error) = pty.rpc(
        pragma_constants::ProtocolRpcMethod::Plugins,
        serde_json::json!({ "action": "reload" }),
    ) {
        log::warn!("plugin installed but host reload failed: {error}");
    }
    Ok(InstallPluginResult {
        package: package.name,
        version: package.version,
        plugin_id: package.pragma.plugin_id,
    })
}

fn validate_request(request: &InstallPluginRequest) -> AppResult<()> {
    let package = Regex::new(r"^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$")
        .map_err(|error| AppError::Plugin(error.to_string()))?;
    let version = Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
        .map_err(|error| AppError::Plugin(error.to_string()))?;
    if !package.is_match(&request.package)
        || !version.is_match(&request.version)
        || !request.integrity.starts_with("sha512-")
        || !Regex::new(r"^[a-f0-9]{64}$")
            .map_err(|error| AppError::Plugin(error.to_string()))?
            .is_match(&request.manifest_sha256)
    {
        return Err(AppError::InvalidInput(
            "invalid locked plugin release".to_string(),
        ));
    }
    Ok(())
}

fn installed_package_dir(install_root: &Path, package: &str) -> AppResult<PathBuf> {
    let mut path = install_root.join("node_modules");
    for segment in package.split('/') {
        path.push(segment);
    }
    if !path.is_dir() {
        return Err(AppError::Plugin(
            "npm did not install expected package directory".to_string(),
        ));
    }
    Ok(path)
}

fn validate_installed_package(
    request: &InstallPluginRequest,
    package_dir: &Path,
    package: &PackageJson,
) -> AppResult<()> {
    if package.name != request.package || package.version != request.version {
        return Err(AppError::Plugin(
            "installed package identity differs from official lock".to_string(),
        ));
    }
    let canonical_dir = pragma_platform::path::canonicalize(package_dir)?;
    let canonical_main =
        pragma_platform::path::canonicalize(package_dir.join(&package.pragma.main))?;
    if !canonical_main.starts_with(&canonical_dir) || !canonical_main.is_file() {
        return Err(AppError::Plugin(
            "plugin main must be a file inside package".to_string(),
        ));
    }
    Ok(())
}

fn run_install_command(package_dir: &Path, install: &InstallCommand) -> AppResult<()> {
    let executable =
        Regex::new(r"^[A-Za-z0-9._+-]+$").map_err(|error| AppError::Plugin(error.to_string()))?;
    if !executable.is_match(&install.command) {
        return Err(AppError::Plugin(
            "install command must be a bare executable".to_string(),
        ));
    }
    let refs: Vec<&str> = install.args.iter().map(String::as_str).collect();
    run_command(&install.command, &refs, Some(package_dir), None).map(|_| ())
}

fn run_command(
    executable: &str,
    args: &[&str],
    cwd: Option<&Path>,
    trailing_path: Option<&Path>,
) -> AppResult<String> {
    let mut command = process_env::command(executable);
    command.args(args);
    if let Some(path) = trailing_path {
        command.arg(path);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|error| AppError::Plugin(format!("failed to run {executable}: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message: String = stderr.chars().take(MAX_COMMAND_OUTPUT_BYTES).collect();
        return Err(AppError::Plugin(format!(
            "{executable} failed: {}",
            message.trim()
        )));
    }
    String::from_utf8(output.stdout).map_err(|error| {
        AppError::Plugin(format!("{executable} returned non-UTF-8 output: {error}"))
    })
}

fn register_global_plugin(
    home: &Path,
    managed_root: &Path,
    package_name: &str,
    package_dir: &Path,
) -> AppResult<()> {
    let config_path = home.join(".pragma").join("config.json");
    let mut config = match std::fs::read_to_string(&config_path) {
        Ok(contents) => serde_json::from_str::<GlobalConfig>(&contents)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => GlobalConfig::default(),
        Err(error) => return Err(error.into()),
    };
    let path = package_dir.display().to_string();
    let managed_prefix = format!("{}-", package_name.replace(['@', '/'], "-"));
    config.plugins.retain(|entry| {
        let entry_path = Path::new(&entry.path);
        entry.path != path
            && !(entry_path.parent() == Some(managed_root)
                && entry_path
                    .file_name()
                    .and_then(std::ffi::OsStr::to_str)
                    .is_some_and(|name| name.starts_with(&managed_prefix)))
    });
    config.plugins.push(PluginEntry {
        path,
        other: serde_json::Map::new(),
    });
    let contents = format!("{}\n", serde_json::to_string_pretty(&config)?);
    let temp_path = config_path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut file = pragma_platform::perms::create_private_file(&temp_path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(temp_path, config_path)?;
    Ok(())
}

fn remove_superseded_installs(managed_root: &Path, package_name: &str, keep: &Path) {
    let managed_prefix = format!("{}-", package_name.replace(['@', '/'], "-"));
    let Ok(entries) = std::fs::read_dir(managed_root) else {
        return;
    };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let is_superseded = path != keep
            && path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .is_some_and(|name| name.starts_with(&managed_prefix));
        if is_superseded {
            if let Err(error) = std::fs::remove_dir_all(&path) {
                log::warn!("failed to remove superseded plugin install: {error}");
            }
        }
    }
}

/// Returns agent binaries that can be executed from Pragma's GUI-safe PATH.
#[tauri::command(async)]
pub fn available_plugin_binaries(binaries: Vec<String>) -> AppResult<Vec<String>> {
    let executable =
        Regex::new(r"^[A-Za-z0-9._+-]+$").map_err(|error| AppError::Plugin(error.to_string()))?;
    Ok(binaries
        .into_iter()
        .filter(|binary| executable.is_match(binary))
        .filter(|binary| process_env::find_executable(binary).is_some())
        .collect())
}

#[tauri::command]
pub fn plugin_onboarding_dismissed(db: State<'_, Db>) -> AppResult<bool> {
    Ok(db.setting(ONBOARDING_DISMISSED_KEY)?.as_deref() == Some("true"))
}

#[tauri::command]
pub fn set_plugin_onboarding_dismissed(db: State<'_, Db>, dismissed: bool) -> AppResult<()> {
    db.set_setting(
        ONBOARDING_DISMISSED_KEY,
        if dismissed { "true" } else { "false" },
    )
}

#[tauri::command]
pub fn agent_plugin_prompt_dismissed(db: State<'_, Db>) -> AppResult<bool> {
    Ok(db.setting(AGENT_PROMPT_DISMISSED_KEY)?.as_deref() == Some("true"))
}

#[tauri::command]
pub fn set_agent_plugin_prompt_dismissed(db: State<'_, Db>, dismissed: bool) -> AppResult<()> {
    db.set_setting(
        AGENT_PROMPT_DISMISSED_KEY,
        if dismissed { "true" } else { "false" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_exact_npm_releases_only() {
        let valid = InstallPluginRequest {
            package: "@pragma-sh/opencode-plugin".to_string(),
            version: "0.1.0-alpha.0".to_string(),
            integrity: "sha512-value".to_string(),
            manifest_sha256: "a".repeat(64),
        };
        assert!(validate_request(&valid).is_ok());
        assert!(validate_request(&InstallPluginRequest {
            package: "https://example.com/plugin.tgz".to_string(),
            ..valid
        })
        .is_err());
    }
}
