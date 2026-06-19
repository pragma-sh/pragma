use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::pty::workspace_root;

/// The plugin file name inside `~/.pragma/plugins/`.
const PLUGIN_FILE_NAME: &str = "opencode.mjs";

/// The `file://` URL prefix that opencode's plugin loader expects.
const FILE_URL_PREFIX: &str = "file://";
const NPM_PLUGIN_ENTRY: &str = "@pragma/opencode-plugin";

/// Ensures the `@pragma/opencode-plugin` dist is installed at
/// `~/.pragma/plugins/opencode.mjs` and referenced by a `file://` path in
/// `~/.config/opencode/opencode.json`'s `plugin` array.
///
/// opencode's plugin loader treats bare package names as npm dependencies and
/// tries to `npm install` them, which 404s for this local package. A `file://`
/// path bypasses npm entirely and loads the dist directly.
pub fn ensure_installed(app: &AppHandle) -> AppResult<()> {
    let home = app.path().home_dir()?;
    let plugins_dir = home.join(".pragma/plugins");
    std::fs::create_dir_all(&plugins_dir)?;
    let destination = plugins_dir.join(PLUGIN_FILE_NAME);
    let source = plugin_source(app)?;
    copy_if_changed(&source, &destination)?;

    let config_path = opencode_config_path(&home);
    ensure_plugin_entry(&config_path, &destination)?;
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

/// Reads the opencode config JSON, ensures the `plugin` array contains a
/// `file://` entry pointing at our installed plugin, and writes it back.
/// Other config keys are preserved untouched. Creates a minimal config if
/// none exists.
fn ensure_plugin_entry(config_path: &Path, plugin_path: &Path) -> AppResult<()> {
    let file_url = format!("{FILE_URL_PREFIX}{}", plugin_path.display());

    let mut config: serde_json::Value = if config_path.is_file() {
        let content = std::fs::read_to_string(config_path)?;
        serde_json::from_str(&content).unwrap_or_else(|_| {
            // Preserve a malformed config before replacing it with a minimal one.
            let backup = config_path.with_extension("json.pragma-bak");
            let _ = std::fs::copy(config_path, &backup);
            serde_json::json!({})
        })
    } else {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        serde_json::json!({})
    };

    let plugins = config
        .as_object_mut()
        .ok_or_else(|| AppError::InvalidInput("opencode config is not a JSON object".to_string()))?
        .entry("plugin")
        .or_insert_with(|| serde_json::json!([]));

    let plugins_arr = plugins.as_array_mut().ok_or_else(|| {
        AppError::InvalidInput("opencode config `plugin` is not an array".to_string())
    })?;

    // Remove the npm-package entry that 404s, plus any previous file path to our plugin.
    plugins_arr.retain(|entry| match entry {
        serde_json::Value::String(s) => {
            s != NPM_PLUGIN_ENTRY
                && (!s.starts_with(FILE_URL_PREFIX) || !s.ends_with(PLUGIN_FILE_NAME))
        }
        _ => true,
    });

    // Add the `file://` entry for our installed plugin.
    plugins_arr.push(serde_json::json!(file_url));

    let json = serde_json::to_string_pretty(&config)?;
    std::fs::write(config_path, json)?;
    Ok(())
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
    use serde_json::Value;
    use tempfile::tempdir;

    use super::ensure_plugin_entry;

    #[test]
    fn ensure_plugin_entry_replaces_npm_entry_with_file_url() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("opencode.json");
        let plugin_path = dir.path().join("opencode.mjs");
        std::fs::write(
            &config_path,
            r#"{
  "plugin": ["@pragma/opencode-plugin", "file:///old/opencode.mjs", "other-plugin"],
  "lsp": true
}"#,
        )
        .expect("write config");

        ensure_plugin_entry(&config_path, &plugin_path).expect("ensure plugin entry");

        let updated: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).expect("read config"))
                .expect("parse config");
        assert_eq!(updated["lsp"], true);
        assert_eq!(
            updated["plugin"],
            serde_json::json!(["other-plugin", format!("file://{}", plugin_path.display())])
        );
    }

    #[test]
    fn ensure_plugin_entry_creates_missing_config() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("nested/opencode.json");
        let plugin_path = dir.path().join("opencode.mjs");

        ensure_plugin_entry(&config_path, &plugin_path).expect("ensure plugin entry");

        let updated: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).expect("read config"))
                .expect("parse config");
        assert_eq!(
            updated["plugin"],
            serde_json::json!([format!("file://{}", plugin_path.display())])
        );
    }
}
