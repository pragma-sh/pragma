use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use pragma_constants::{
    KeybindingChord, KeybindingChordModifiersItem, Keybindings, KeybindingsConfig, PlatformChord,
};

use crate::error::AppResult;

const CONFIG_DIR: &str = ".pragma";
const CONFIG_FILE: &str = "keybindings.json";

/// Returns the path to the user keybindings config file (`~/.pragma/keybindings.json`).
pub fn config_path(home_dir: impl AsRef<Path>) -> PathBuf {
    home_dir.as_ref().join(CONFIG_DIR).join(CONFIG_FILE)
}

/// Loads the keybindings config, writing the default file first if it is missing.
///
/// Pragma keeps this file in the user's home directory so it is easy to edit by
/// hand and survives app reinstalls. New actions added after the user created
/// their config are merged in from the defaults so old files stay valid.
pub fn load_or_ensure(home_dir: impl AsRef<Path>) -> AppResult<KeybindingsConfig> {
    let path = config_path(home_dir);
    if !path.exists() {
        write_defaults(&path)?;
        let content = std::fs::read_to_string(&path)?;
        return Ok(serde_json::from_str(&content)?);
    }
    let content = std::fs::read_to_string(&path)?;
    let user: serde_json::Value = serde_json::from_str(&content)?;
    let merged = merge_with_defaults(user);
    let config: KeybindingsConfig = serde_json::from_value(merged)?;
    Ok(config)
}

/// Saves a keybindings config back to disk.
pub fn save(home_dir: impl AsRef<Path>, config: &KeybindingsConfig) -> AppResult<()> {
    let path = config_path(home_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(config)?)?;
    Ok(())
}

fn write_defaults(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&default_config())?)?;
    Ok(())
}

/// Merges a user config value with the default config so that newly-added
/// actions get defaults while preserving any customizations the user made.
fn merge_with_defaults(user: serde_json::Value) -> serde_json::Value {
    let default = serde_json::to_value(default_config()).expect("default config serializes");
    merge_json(default, user)
}

/// Recursively overlays `overlay` onto `base`. Object keys missing in `overlay`
/// keep their `base` values; other values are taken from `overlay`.
fn merge_json(base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
    match (base, overlay) {
        (serde_json::Value::Object(mut base_map), serde_json::Value::Object(overlay_map)) => {
            for (key, overlay_value) in overlay_map {
                let base_value = base_map.remove(&key);
                let merged = match base_value {
                    Some(base_value) => merge_json(base_value, overlay_value),
                    None => overlay_value,
                };
                base_map.insert(key, merged);
            }
            serde_json::Value::Object(base_map)
        }
        (_, overlay) => overlay,
    }
}

fn default_config() -> KeybindingsConfig {
    KeybindingsConfig {
        version: NonZeroU64::new(1).expect("1 is non-zero"),
        bindings: Keybindings {
            next_tab: chord("ctrl", "tab", "alt", "tab"),
            previous_tab: chord("ctrl+shift", "tab", "alt+shift", "tab"),
            close_top_tab: chord("cmd", "w", "ctrl", "w"),
            new_terminal_tab: chord("cmd", "t", "ctrl", "t"),
            new_browser_tab: chord("cmd", "b", "ctrl", "b"),
            clear_terminal: chord("cmd", "k", "ctrl", "k"),
            browser_reload: chord("cmd", "r", "ctrl", "r"),
            browser_devtools: chord("cmd+shift", "i", "ctrl+shift", "i"),
            browser_copy_url: chord("cmd+shift", "c", "ctrl+shift", "c"),
            split_horizontal: chord("cmd", "/", "ctrl", "/"),
            split_vertical: chord("cmd+shift", "/", "ctrl+shift", "/"),
            delete_file: chord("cmd", "backspace", "ctrl", "delete"),
            switch_to_workspace1: chord("ctrl", "1", "alt", "1"),
            switch_to_workspace2: chord("ctrl", "2", "alt", "2"),
            switch_to_workspace3: chord("ctrl", "3", "alt", "3"),
            switch_to_workspace4: chord("ctrl", "4", "alt", "4"),
            switch_to_workspace5: chord("ctrl", "5", "alt", "5"),
            switch_to_workspace6: chord("ctrl", "6", "alt", "6"),
            switch_to_workspace7: chord("ctrl", "7", "alt", "7"),
            switch_to_workspace8: chord("ctrl", "8", "alt", "8"),
            switch_to_workspace9: chord("ctrl", "9", "alt", "9"),
        },
    }
}

fn chord(mac_mods: &str, mac_key: &str, linux_mods: &str, linux_key: &str) -> PlatformChord {
    PlatformChord {
        mac: parse_chord(mac_mods, mac_key),
        linux: parse_chord(linux_mods, linux_key),
    }
}

fn parse_chord(modifiers: &str, key: &str) -> KeybindingChord {
    KeybindingChord {
        modifiers: modifiers.split('+').map(parse_modifier).collect(),
        key: key.to_string(),
    }
}

fn parse_modifier(modifier: &str) -> KeybindingChordModifiersItem {
    match modifier {
        "cmd" => KeybindingChordModifiersItem::Cmd,
        "ctrl" => KeybindingChordModifiersItem::Ctrl,
        "alt" => KeybindingChordModifiersItem::Alt,
        "shift" => KeybindingChordModifiersItem::Shift,
        _ => panic!("unknown modifier: {modifier}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_serializes_to_valid_json() {
        let config = default_config();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: KeybindingsConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version.get(), 1);
        assert_eq!(parsed.bindings.next_tab.mac.key, "tab");
        assert_eq!(
            parsed.bindings.close_top_tab.linux.modifiers,
            [KeybindingChordModifiersItem::Ctrl]
        );
        assert_eq!(parsed.bindings.delete_file.mac.key, "backspace");
        assert_eq!(parsed.bindings.delete_file.linux.key, "delete");
    }

    #[test]
    fn load_or_ensure_writes_defaults_for_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let config = load_or_ensure(home).unwrap();
        assert_eq!(config.version.get(), 1);
        assert!(config_path(home).exists());
    }

    #[test]
    fn save_round_trips_custom_config() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut config = default_config();
        config.bindings.new_terminal_tab.mac.key = "n".to_string();
        save(home, &config).unwrap();
        let loaded = load_or_ensure(home).unwrap();
        assert_eq!(loaded.bindings.new_terminal_tab.mac.key, "n");
    }

    #[test]
    fn load_or_ensure_merges_missing_actions_from_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let legacy_json = serde_json::json!({
            "version": 1,
            "bindings": {
                "nextTab": { "mac": { "modifiers": ["ctrl"], "key": "tab" }, "linux": { "modifiers": ["alt"], "key": "tab" } }
            }
        });
        std::fs::create_dir_all(config_path(home).parent().unwrap()).unwrap();
        std::fs::write(config_path(home), legacy_json.to_string()).unwrap();

        let loaded = load_or_ensure(home).unwrap();

        assert_eq!(loaded.bindings.clear_terminal.mac.key, "k");
        assert_eq!(loaded.bindings.next_tab.mac.key, "tab");
    }
}
