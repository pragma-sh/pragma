//! Plugin configuration reading and bundle resolution.
//!
//! Pragma plugins are declared in `.pragma/config.json` files — one global file
//! in the user's home directory and one optional file per project root — with
//! the schema `{ "plugins": [{ "path": string, "config"?: object }] }`.
//!
//! This module resolves each declared entry to a plugin manifest (the plugin
//! directory's `package.json` name/version/main) without ever executing plugin
//! code. Failures are returned per entry — never silently skipped — so the
//! frontend can surface every broken plugin to the user. Only local-path
//! specifiers are supported for now; npm specifiers return a typed
//! "not supported yet" error until remote fetching lands.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use pragma_constants::CONSTANTS;

use crate::error::{AppError, AppResult};
use crate::pty::workspace_root;

/// One `plugins[]` entry in a `.pragma/config.json` file.
#[derive(Debug, Clone, Deserialize)]
pub struct PluginConfigEntry {
    /// Plugin specifier. Relative local paths (`./`, `../`, and the `.\` / `..\`
    /// spellings) resolve against the config file's directory; absolute paths
    /// (`/…`, `~/…`, and Windows forms like `C:\…`) resolve as given. Anything
    /// else is treated as an npm specifier (unsupported for now).
    pub path: String,
    /// Optional plugin configuration object, validated by the plugin's own
    /// zod schema on the frontend.
    pub config: Option<serde_json::Value>,
}

/// The subset of `.pragma/config.json` this module cares about. Unknown keys
/// are ignored so other Pragma features can share the file.
#[derive(Debug, Default, Deserialize)]
struct PragmaConfigFile {
    #[serde(default)]
    plugins: Vec<PluginConfigEntry>,
}

/// Where a plugin entry was declared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginScope {
    /// Shipped inside the app resource directory.
    Bundled,
    /// Declared in `~/.pragma/config.json`.
    Global,
    /// Declared in `<project>/.pragma/config.json`.
    Project,
}

/// Resolved metadata for a plugin directory, read from its `package.json`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Package name from `package.json`.
    pub name: String,
    /// Package version from `package.json`.
    pub version: String,
    /// Absolute path of the plugin directory.
    pub dir: String,
    /// Absolute path of the bundle file `main` points at.
    pub main_path: String,
    /// Bundle file mtime in milliseconds since the epoch (for dev hot-reload
    /// polling). `None` when the filesystem does not report one.
    pub modified_ms: Option<u64>,
}

/// Per-entry resolution result. Exactly one of `manifest` / `error` is set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntryResult {
    /// The original `path` specifier from the config file.
    pub specifier: String,
    /// Which config file declared this entry.
    pub scope: PluginScope,
    /// Project root path for `scope: "project"` entries.
    pub project_path: Option<String>,
    /// The entry's `config` object, passed through untouched.
    pub config: Option<serde_json::Value>,
    /// Resolved manifest when the entry resolved successfully.
    pub manifest: Option<PluginManifest>,
    /// Human-readable resolution error when it did not.
    pub error: Option<String>,
}

/// Request to start one host-side plugin watcher instance.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWatcherRequest {
    pub plugin_id: String,
    pub plugin_main: String,
    #[serde(rename = "agentId")]
    pub _agent_id: String,
    pub watcher_agent: String,
    pub config: serde_json::Value,
    pub session_id: String,
    pub tab_id: String,
    pub worktree_id: String,
    pub gateway_url: String,
    pub gateway_token: String,
}

/// Minimal `package.json` shape for plugin manifests.
#[derive(Debug, Deserialize)]
struct PackageJson {
    name: Option<String>,
    version: Option<String>,
    main: Option<String>,
    pragma: Option<PragmaPackageJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PragmaPackageJson {
    plugin_id: Option<String>,
    main: Option<String>,
}

/// Returns the path of a `.pragma/config.json` under `root` (home or project).
pub fn config_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(&CONSTANTS.plugins.config_file_name)
}

/// Reads and resolves plugin entries declared for the global scope (under
/// `home_dir`) followed by the optional project scope (under `project_path`),
/// preserving declaration order. A missing config file yields no entries; a
/// malformed one yields a single error entry so the failure is visible.
pub fn read_manifests(
    home_dir: impl AsRef<Path>,
    project_path: Option<&Path>,
    resource_dir: Option<&Path>,
) -> Vec<PluginEntryResult> {
    let home = home_dir.as_ref();
    let mut results = resource_dir.map_or_else(Vec::new, read_bundled_scope);
    results.extend(read_scope(home, home, PluginScope::Global, None));
    if let Some(project) = project_path {
        results.extend(read_scope(
            project,
            home,
            PluginScope::Project,
            Some(project),
        ));
    }
    results
}

fn read_bundled_scope(resource_dir: &Path) -> Vec<PluginEntryResult> {
    let relative = Path::new(CONSTANTS.plugins.bundled_dir_name.as_str());
    let dir = [
        resource_dir.join(relative),
        resource_dir.join("resources").join(relative),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
    .unwrap_or_else(|| resource_dir.join(relative));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut plugin_dirs: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    plugin_dirs.sort();
    plugin_dirs
        .into_iter()
        .map(|plugin_dir| {
            let resolved = read_manifest(&plugin_dir);
            PluginEntryResult {
                specifier: plugin_dir.display().to_string(),
                scope: PluginScope::Bundled,
                project_path: None,
                config: None,
                manifest: resolved.as_ref().ok().cloned(),
                error: resolved.err(),
            }
        })
        .collect()
}

/// Reads the bundle source for a resolved plugin `main` file.
pub fn read_bundle(main_path: &Path) -> AppResult<String> {
    std::fs::read_to_string(main_path).map_err(|error| {
        AppError::Plugin(format!(
            "failed to read plugin bundle {}: {error}",
            main_path.display()
        ))
    })
}

/// Starts a detached `pragma-watch` sidecar for one plugin watcher.
pub fn start_watcher(request: StartWatcherRequest) -> AppResult<()> {
    let mut command = watcher_command();
    command
        .args([
            "--pluginId",
            &request.plugin_id,
            "--pluginMain",
            &request.plugin_main,
            "--agentId",
            &request.watcher_agent,
            "--watcherAgent",
            &request.watcher_agent,
            "--config",
            &request.config.to_string(),
            "--sessionId",
            &request.session_id,
            "--tabId",
            &request.tab_id,
            "--worktreeId",
            &request.worktree_id,
            "--gatewayUrl",
            &request.gateway_url,
            "--gatewayToken",
            &request.gateway_token,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let mut child = command.spawn()?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn watcher_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = crate::process_env::command("bun");
        command.arg(workspace_root().join("packages/watcher/src/cli.ts"));
        command.current_dir(workspace_root());
        command
    } else {
        let path = pragma_client::sidecar_executable("pragma-watch");
        crate::process_env::command(&path.to_string_lossy())
    }
}

/// Reads one scope's config file and resolves every declared entry.
fn read_scope(
    root: &Path,
    home: &Path,
    scope: PluginScope,
    project: Option<&Path>,
) -> Vec<PluginEntryResult> {
    let path = config_path(root);
    let project_path = project.map(|p| p.display().to_string());
    let entries = match load_config(&path) {
        Ok(config) => config.plugins,
        Err(error) => {
            return vec![PluginEntryResult {
                specifier: path.display().to_string(),
                scope,
                project_path,
                config: None,
                manifest: None,
                error: Some(error),
            }];
        }
    };
    let config_dir = path
        .parent()
        .map_or_else(|| root.to_path_buf(), Path::to_path_buf);
    entries
        .into_iter()
        .map(|entry| {
            let resolved = resolve_entry(&config_dir, home, &entry.path);
            PluginEntryResult {
                specifier: entry.path,
                scope,
                project_path: project_path.clone(),
                config: entry.config,
                manifest: resolved.as_ref().ok().cloned(),
                error: resolved.err(),
            }
        })
        .collect()
}

/// Parses a `.pragma/config.json` file, treating a missing file as empty.
fn load_config(path: &Path) -> Result<PragmaConfigFile, String> {
    if !path.exists() {
        return Ok(PragmaConfigFile::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("invalid plugin config {}: {error}", path.display()))
}

/// Resolves one specifier to a plugin manifest.
///
/// Local specifiers resolve relative to the config file's directory. Anything
/// that does not look like a filesystem path is treated as an npm specifier,
/// which is not supported yet (Phase 5 adds fetching).
fn resolve_entry(
    config_dir: &Path,
    home: &Path,
    specifier: &str,
) -> Result<PluginManifest, String> {
    let Some(dir) = resolve_local_dir(config_dir, home, specifier) else {
        return Err(format!(
            "npm plugin specifiers are not supported yet: \"{specifier}\" (use a local path)"
        ));
    };
    if !dir.is_dir() {
        return Err(format!("plugin directory not found: {}", dir.display()));
    }
    read_manifest(&dir)
}

/// Maps a local-path specifier to an absolute plugin directory, or `None` for
/// non-path (npm) specifiers.
fn resolve_local_dir(config_dir: &Path, home: &Path, specifier: &str) -> Option<PathBuf> {
    if let Some(rest) = specifier
        .strip_prefix("~/")
        .or_else(|| specifier.strip_prefix(r"~\"))
    {
        return Some(normalize(&home.join(rest)));
    }
    let path = Path::new(specifier);
    // `is_absolute` is the platform-correct test. A bare `starts_with('/')` check
    // misses every Windows absolute form — `C:\…` and the `\\?\C:\…` verbatim
    // paths `std::fs::canonicalize` produces — so those fell through and were
    // misreported as unsupported npm specifiers. The leading-slash case is kept
    // so a POSIX-style path in a shared config still resolves on Windows, where
    // `is_absolute` rejects it for lacking a drive letter.
    if path.is_absolute() || specifier.starts_with('/') {
        return Some(normalize(path));
    }
    if is_explicit_relative(path) {
        return Some(normalize(&config_dir.join(path)));
    }
    None
}

/// True when a specifier explicitly opts into relative resolution.
///
/// Component-based so it covers `./` and `../` as well as the `.\` and `..\`
/// spellings Windows users write. A leading `.` survives `Path::components`,
/// which is what makes this reliable.
fn is_explicit_relative(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(std::path::Component::CurDir | std::path::Component::ParentDir)
    )
}

/// Lexically normalizes `.` / `..` segments without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

/// Reads and validates a plugin directory's `package.json`.
fn read_manifest(dir: &Path) -> Result<PluginManifest, String> {
    let package_path = dir.join("package.json");
    let content = std::fs::read_to_string(&package_path)
        .map_err(|error| format!("failed to read {}: {error}", package_path.display()))?;
    let package: PackageJson = serde_json::from_str(&content)
        .map_err(|error| format!("invalid {}: {error}", package_path.display()))?;
    let name = package
        .pragma
        .as_ref()
        .and_then(|pragma| pragma.plugin_id.clone())
        .or(package.name)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{} is missing \"name\"", package_path.display()))?;
    let version = package
        .version
        .filter(|version| !version.is_empty())
        .ok_or_else(|| format!("{} is missing \"version\"", package_path.display()))?;
    let main = package
        .pragma
        .and_then(|pragma| pragma.main)
        .or(package.main)
        .filter(|main| !main.is_empty())
        .ok_or_else(|| format!("{} is missing \"main\"", package_path.display()))?;
    let main_path = normalize(&dir.join(&main));
    if !main_path.is_file() {
        return Err(format!(
            "plugin \"{name}\" main bundle not found: {}",
            main_path.display()
        ));
    }
    let modified_ms = std::fs::metadata(&main_path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    Ok(PluginManifest {
        name,
        version,
        dir: dir.display().to_string(),
        main_path: main_path.display().to_string(),
        modified_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the specifier forms `resolve_local_dir` must accept. Windows
    /// absolute paths (`C:\…`) used to fall through every branch and surface as
    /// "npm plugin specifiers are not supported yet", making an absolute
    /// `plugins[].path` unusable on that platform.
    #[test]
    fn local_dir_accepts_each_platform_path_form() {
        let (config_dir, home, absolute) = if cfg!(windows) {
            (
                Path::new(r"C:\cfg\.pragma"),
                Path::new(r"C:\home\me"),
                r"C:\abs\p",
            )
        } else {
            (Path::new("/cfg/.pragma"), Path::new("/home/me"), "/abs/p")
        };

        // Bare and scoped names remain npm specifiers.
        assert!(resolve_local_dir(config_dir, home, "my-plugin").is_none());
        assert!(resolve_local_dir(config_dir, home, "@pragma/thing").is_none());

        assert_eq!(
            resolve_local_dir(config_dir, home, absolute).as_deref(),
            Some(Path::new(absolute))
        );
        assert_eq!(
            resolve_local_dir(config_dir, home, "~/p").as_deref(),
            Some(home.join("p").as_path())
        );
        assert_eq!(
            resolve_local_dir(config_dir, home, "../p").as_deref(),
            Some(normalize(&config_dir.join("../p")).as_path())
        );
        // A POSIX-style absolute path stays resolvable on Windows, where
        // `Path::is_absolute` rejects it for lacking a drive letter.
        assert!(resolve_local_dir(config_dir, home, "/abs/p").is_some());
        // Windows users write these spellings; they must resolve relatively.
        if cfg!(windows) {
            assert_eq!(
                resolve_local_dir(config_dir, home, r"..\p").as_deref(),
                Some(normalize(&config_dir.join("../p")).as_path())
            );
            assert!(resolve_local_dir(config_dir, home, r".\p").is_some());
        }
    }

    fn write_config(root: &Path, json: &serde_json::Value) {
        let path = config_path(root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, json.to_string()).unwrap();
    }

    fn write_plugin(dir: &Path, name: &str, version: &str, main: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            serde_json::json!({ "name": name, "version": version, "main": main }).to_string(),
        )
        .unwrap();
        let main_path = dir.join(main);
        std::fs::create_dir_all(main_path.parent().unwrap()).unwrap();
        std::fs::write(main_path, "export default {};").unwrap();
    }

    #[test]
    fn missing_config_yields_no_entries() {
        let temp = tempfile::tempdir().unwrap();
        let results = read_manifests(temp.path(), None, None);
        assert!(results.is_empty());
    }

    #[test]
    fn malformed_config_yields_error_entry() {
        let temp = tempfile::tempdir().unwrap();
        let path = config_path(temp.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        let results = read_manifests(temp.path(), None, None);
        assert_eq!(results.len(), 1);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap()
            .contains("invalid plugin config"));
    }

    #[test]
    fn resolves_local_plugin_relative_to_config_dir() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        // Plugin lives next to the config file's parent: <home>/my-plugin.
        write_plugin(
            &home.join("my-plugin"),
            "my-plugin",
            "1.2.3",
            "dist/index.js",
        );
        write_config(
            home,
            &serde_json::json!({ "plugins": [{ "path": "../my-plugin" }] }),
        );

        let results = read_manifests(home, None, None);
        assert_eq!(results.len(), 1);
        let manifest = results[0].manifest.as_ref().expect("manifest resolved");
        assert_eq!(manifest.name, "my-plugin");
        assert_eq!(manifest.version, "1.2.3");
        // Component-wise: the resolved path uses the platform separator, so a
        // literal "dist/index.js" suffix never matches on Windows.
        assert!(Path::new(&manifest.main_path).ends_with(Path::new("dist").join("index.js")));
        assert_eq!(results[0].scope, PluginScope::Global);
        assert!(results[0].error.is_none());
    }

    #[test]
    fn absolute_specifier_resolves_directly() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let plugin_dir = home.join("elsewhere/plugin");
        write_plugin(&plugin_dir, "abs-plugin", "0.1.0", "index.js");
        write_config(
            home,
            &serde_json::json!({ "plugins": [{ "path": plugin_dir.display().to_string() }] }),
        );

        let results = read_manifests(home, None, None);
        assert_eq!(results[0].manifest.as_ref().unwrap().name, "abs-plugin");
    }

    #[test]
    fn npm_specifier_returns_unsupported_error() {
        let temp = tempfile::tempdir().unwrap();
        write_config(
            temp.path(),
            &serde_json::json!({ "plugins": [{ "path": "@pragma/some-plugin" }] }),
        );
        let results = read_manifests(temp.path(), None, None);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap()
            .contains("not supported yet"));
        assert!(results[0].manifest.is_none());
    }

    #[test]
    fn missing_main_is_a_hard_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let plugin_dir = home.join("broken");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("package.json"),
            serde_json::json!({ "name": "broken", "version": "1.0.0" }).to_string(),
        )
        .unwrap();
        write_config(
            home,
            &serde_json::json!({ "plugins": [{ "path": "../broken" }] }),
        );

        let results = read_manifests(home, None, None);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap()
            .contains("missing \"main\""));
    }

    #[test]
    fn main_pointing_at_missing_file_is_a_hard_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let plugin_dir = home.join("ghost");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("package.json"),
            serde_json::json!({ "name": "ghost", "version": "1.0.0", "main": "nope.js" })
                .to_string(),
        )
        .unwrap();
        write_config(
            home,
            &serde_json::json!({ "plugins": [{ "path": "../ghost" }] }),
        );

        let results = read_manifests(home, None, None);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap()
            .contains("main bundle not found"));
    }

    #[test]
    fn merges_global_then_project_entries_in_order() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        write_plugin(
            &home.join("global-plugin"),
            "global-plugin",
            "1.0.0",
            "index.js",
        );
        write_plugin(
            &project.join("local-plugin"),
            "local-plugin",
            "2.0.0",
            "index.js",
        );
        write_config(
            &home,
            &serde_json::json!({ "plugins": [{ "path": "../global-plugin" }] }),
        );
        write_config(
            &project,
            &serde_json::json!({
                "plugins": [{ "path": "../local-plugin", "config": { "level": 3 } }]
            }),
        );

        let results = read_manifests(&home, Some(&project), None);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].scope, PluginScope::Global);
        assert_eq!(results[0].manifest.as_ref().unwrap().name, "global-plugin");
        assert_eq!(results[1].scope, PluginScope::Project);
        assert_eq!(results[1].manifest.as_ref().unwrap().name, "local-plugin");
        assert_eq!(results[1].config, Some(serde_json::json!({ "level": 3 })));
        assert_eq!(
            results[1].project_path.as_deref(),
            Some(project.to_str().unwrap())
        );
    }

    #[test]
    fn read_bundle_returns_source() {
        let temp = tempfile::tempdir().unwrap();
        let plugin_dir = temp.path().join("plugin");
        write_plugin(&plugin_dir, "p", "1.0.0", "index.js");
        let source = read_bundle(&plugin_dir.join("index.js")).unwrap();
        assert_eq!(source, "export default {};");
    }

    #[test]
    fn sample_fixture_plugin_resolves() {
        // The hand-written fixture under packages/plugin/test-fixtures must
        // stay loadable through the real resolution path.
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/plugin/test-fixtures/sample-plugin");
        if !fixture.is_dir() {
            // Partial checkouts may omit sibling packages; skip rather than fail.
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        write_config(
            temp.path(),
            // `pragma_platform::path::canonicalize`, never `std::fs`'s: the latter
            // returns a `\\?\C:\…` verbatim path on Windows (see AGENTS.md).
            &serde_json::json!({ "plugins": [{ "path": pragma_platform::path::canonicalize(&fixture).unwrap().display().to_string() }] }),
        );
        let results = read_manifests(temp.path(), None, None);
        let manifest = results[0].manifest.as_ref().expect("fixture resolves");
        assert_eq!(manifest.name, "sample-pragma-plugin");
        assert!(read_bundle(Path::new(&manifest.main_path))
            .unwrap()
            .contains("__apiVersion"));
    }
}
