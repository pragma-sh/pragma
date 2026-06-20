use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::pty::workspace_root;

/// The file name we install the plugin dist under, inside Pragma's storage dir.
const PLUGIN_FILE_NAME: &str = "opencode.mjs";

/// The bare npm package name older installs put in the config `plugin` array.
/// opencode tries to npm-install array entries that look like package names, and
/// this package is not published, so it must never be registered by name.
const NPM_PLUGIN_ENTRY: &str = "@pragma/opencode-plugin";

/// Ensures the `@pragma/opencode-plugin` dist is installed and registered with
/// opencode.
///
/// opencode loads plugins **only** from the `plugin` array in
/// `~/.config/opencode/opencode.json` — it does *not* auto-scan any plugin
/// directory (verified empirically against opencode 1.17.8: a file dropped in
/// `~/.config/opencode/plugins/` or a project `.opencode/plugin/` is never
/// loaded; only an array entry is). A **file path** entry loads fine and is
/// *not* npm-resolved — only the bare package name [`NPM_PLUGIN_ENTRY`] is.
///
/// So we stage the dist to a stable path and register that absolute path in the
/// config array, removing any stale Pragma entries (the bare npm name, or an old
/// path pointing elsewhere) first.
pub fn ensure_installed(app: &AppHandle) -> AppResult<()> {
    let home = app.path().home_dir()?;
    let plugins_dir = opencode_plugins_dir(&home);
    std::fs::create_dir_all(&plugins_dir)?;
    let destination = plugins_dir.join(PLUGIN_FILE_NAME);
    let source = plugin_source(app)?;
    copy_if_changed(&source, &destination)?;

    let config_path = opencode_config_path(&home);
    ensure_config_plugin_entry(&config_path, &destination)?;
    Ok(())
}

fn plugin_source(app: &AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        let dist = workspace_root().join("packages/opencode-plugin/dist/index.mjs");
        if dist.is_file() {
            return Ok(dist);
        }
        // Fall back to the staged resource if the dist hasn't been built yet.
        Ok(app
            .path()
            .resource_dir()?
            .join("pragma/plugins")
            .join(PLUGIN_FILE_NAME))
    } else {
        Ok(app
            .path()
            .resource_dir()?
            .join("pragma/plugins")
            .join(PLUGIN_FILE_NAME))
    }
}

fn opencode_config_path(home: &Path) -> PathBuf {
    home.join(".config/opencode/opencode.json")
}

fn opencode_plugins_dir(home: &Path) -> PathBuf {
    home.join(".config/opencode/plugins")
}

/// Registers `destination` in opencode's `plugin` config array, removing any
/// stale Pragma entries first. Other config keys and entries are preserved.
///
/// A previous install may have left the bare npm name (which opencode tries to
/// fetch from the registry and fails on) or a path pointing at an old location
/// (e.g. before the home dir moved); both — and any prior `opencode.mjs` entry,
/// whether a plain path or a `file://` URL — are dropped before the current
/// absolute path is added. Creates the config file if it does not exist.
fn ensure_config_plugin_entry(config_path: &Path, destination: &Path) -> AppResult<()> {
    let entry = destination.to_string_lossy().into_owned();

    let mut config = if config_path.is_file() {
        let content = std::fs::read_to_string(config_path)?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
            value
        } else {
            // Don't clobber an unparseable config; opencode would reject it too.
            // Preserve it as a backup and leave the original in place.
            let backup = config_path.with_extension("json.pragma-bak");
            let _ = std::fs::copy(config_path, &backup);
            return Ok(());
        }
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };

    let object = config.as_object_mut().ok_or_else(|| {
        AppError::InvalidInput("opencode config is not a JSON object".to_string())
    })?;

    let plugins = object
        .entry("plugin")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let plugins_arr = plugins.as_array_mut().ok_or_else(|| {
        AppError::InvalidInput("opencode config `plugin` is not an array".to_string())
    })?;

    let before = plugins_arr.clone();
    plugins_arr.retain(|item| match item {
        serde_json::Value::String(s) => s != NPM_PLUGIN_ENTRY && !is_pragma_plugin_path(s),
        _ => true,
    });
    plugins_arr.push(serde_json::Value::String(entry));

    if plugins_arr.as_slice() == before.as_slice() {
        return Ok(());
    }

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&config)?;
    std::fs::write(config_path, json)?;
    Ok(())
}

/// Whether `entry` is a (possibly stale) reference to Pragma's installed plugin
/// file — a plain path or a `file://` URL ending in the plugin file name.
fn is_pragma_plugin_path(entry: &str) -> bool {
    entry.ends_with(PLUGIN_FILE_NAME) && (entry.contains('/') || entry.contains('\\'))
}

fn copy_if_changed(source: &Path, destination: &Path) -> AppResult<()> {
    let source_bytes = std::fs::read(source)?;
    let needs_copy = std::fs::read(destination).map_or(true, |existing| existing != source_bytes);
    if needs_copy {
        std::fs::write(destination, source_bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::ensure_config_plugin_entry;

    fn read(config_path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(config_path).expect("read config"))
            .expect("parse config")
    }

    #[test]
    fn registers_plugin_path_and_drops_stale_pragma_entries() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("opencode.json");
        std::fs::write(
            &config_path,
            r#"{
  "plugin": ["@pragma/opencode-plugin", "file:///old/opencode.mjs", "other-plugin"],
  "lsp": true
}"#,
        )
        .expect("write config");
        let destination = dir.path().join("plugins/opencode.mjs");

        ensure_config_plugin_entry(&config_path, &destination).expect("register plugin");

        let updated = read(&config_path);
        assert_eq!(updated["lsp"], true);
        assert_eq!(
            updated["plugin"],
            serde_json::json!(["other-plugin", destination.to_string_lossy()])
        );
    }

    #[test]
    fn creates_config_when_missing() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("nested/opencode.json");
        let destination = dir.path().join("plugins/opencode.mjs");

        ensure_config_plugin_entry(&config_path, &destination).expect("register plugin");

        let updated = read(&config_path);
        assert_eq!(
            updated["plugin"],
            serde_json::json!([destination.to_string_lossy()])
        );
    }

    #[test]
    fn is_idempotent() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("opencode.json");
        let destination = dir.path().join("plugins/opencode.mjs");

        ensure_config_plugin_entry(&config_path, &destination).expect("register plugin once");
        ensure_config_plugin_entry(&config_path, &destination).expect("register plugin twice");

        let updated = read(&config_path);
        assert_eq!(
            updated["plugin"],
            serde_json::json!([destination.to_string_lossy()])
        );
    }

    #[test]
    fn preserves_unparseable_config_as_backup() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("opencode.json");
        std::fs::write(&config_path, "{ not json").expect("write config");
        let destination = dir.path().join("plugins/opencode.mjs");

        ensure_config_plugin_entry(&config_path, &destination).expect("handle bad config");

        assert!(config_path.with_extension("json.pragma-bak").exists());
    }
}
