use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use pragma_constants::{
    KeybindingChord, KeybindingChordModifiersItem, Keybindings, KeybindingsConfig, PlatformChord,
    CONSTANTS,
};

use crate::error::{AppError, AppResult};

/// Returns the path to the user keybindings config file (`~/.pragma/keybindings.json`).
pub fn config_path(home_dir: impl AsRef<Path>) -> PathBuf {
    home_dir
        .as_ref()
        .join(CONSTANTS.keybindings.config_file_name.as_str())
}

/// Loads the keybindings config, writing the default file first if it is missing.
///
/// Pragma keeps this file in the user's home directory so it is easy to edit by
/// hand and survives app reinstalls. New actions added after the user created
/// their config are merged in from the defaults so old files stay valid.
pub fn load_or_ensure(home_dir: impl AsRef<Path>) -> AppResult<KeybindingsConfig> {
    let overrides = read_or_ensure_text(home_dir)?;
    effective(&overrides, None)
}

/// Reads the global keybindings file verbatim, writing the defaults first if it
/// is missing so the user always has a complete file to hand-edit.
pub fn read_or_ensure_text(home_dir: impl AsRef<Path>) -> AppResult<String> {
    let path = config_path(home_dir);
    if !path.exists() {
        write_defaults(&path)?;
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Resolves the config that actually applies: built-in defaults overlaid with the
/// global file, then with the project file (when a project is selected). Each
/// layer only needs the actions it overrides.
pub fn effective(global: &str, project: Option<&str>) -> AppResult<KeybindingsConfig> {
    let mut merged = serde_json::to_value(default_config()).expect("default config serializes");
    for layer in [Some(global), project].into_iter().flatten() {
        merged = merge_json(merged, parse_overrides(layer)?);
    }
    Ok(serde_json::from_value(merged)?)
}

/// Checks that an overrides file still merges into a valid config. Rejecting a
/// bad write here keeps a typo in Settings from breaking every shortcut.
pub fn validate_overrides(contents: &str) -> AppResult<()> {
    effective(contents, None).map(|_| ())
}

/// Parses one overrides layer. Blank files are treated as "no overrides" so a
/// freshly-created project file behaves like an absent one.
fn parse_overrides(contents: &str) -> AppResult<serde_json::Value> {
    if contents.trim().is_empty() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    let value: serde_json::Value = serde_json::from_str(contents)?;
    if !value.is_object() {
        return Err(AppError::InvalidInput(
            "keybindings.json root must be an object".to_string(),
        ));
    }
    Ok(value)
}

fn write_defaults(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&default_config())?)?;
    Ok(())
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
            scroll_terminal_bottom: chord("cmd", "end", "ctrl", "end"),
            open_command_palette: chord("cmd", "p", "ctrl", "p"),
            open_command_mode: chord("cmd+shift", "p", "ctrl+shift", "p"),
            switch_to_workspace1: chord("ctrl", "1", "alt", "1"),
            switch_to_workspace2: chord("ctrl", "2", "alt", "2"),
            switch_to_workspace3: chord("ctrl", "3", "alt", "3"),
            switch_to_workspace4: chord("ctrl", "4", "alt", "4"),
            switch_to_workspace5: chord("ctrl", "5", "alt", "5"),
            switch_to_workspace6: chord("ctrl", "6", "alt", "6"),
            switch_to_workspace7: chord("ctrl", "7", "alt", "7"),
            switch_to_workspace8: chord("ctrl", "8", "alt", "8"),
            switch_to_workspace9: chord("ctrl", "9", "alt", "9"),
            switch_to_worktree1: chord("cmd", "1", "ctrl", "1"),
            switch_to_worktree2: chord("cmd", "2", "ctrl", "2"),
            switch_to_worktree3: chord("cmd", "3", "ctrl", "3"),
            switch_to_worktree4: chord("cmd", "4", "ctrl", "4"),
            switch_to_worktree5: chord("cmd", "5", "ctrl", "5"),
            switch_to_worktree6: chord("cmd", "6", "ctrl", "6"),
            switch_to_worktree7: chord("cmd", "7", "ctrl", "7"),
            switch_to_worktree8: chord("cmd", "8", "ctrl", "8"),
            switch_to_worktree9: chord("cmd", "9", "ctrl", "9"),
            switch_to_tab1: chord("alt+shift", "1", "alt+shift", "1"),
            switch_to_tab2: chord("alt+shift", "2", "alt+shift", "2"),
            switch_to_tab3: chord("alt+shift", "3", "alt+shift", "3"),
            switch_to_tab4: chord("alt+shift", "4", "alt+shift", "4"),
            switch_to_tab5: chord("alt+shift", "5", "alt+shift", "5"),
            switch_to_tab6: chord("alt+shift", "6", "alt+shift", "6"),
            switch_to_tab7: chord("alt+shift", "7", "alt+shift", "7"),
            switch_to_tab8: chord("alt+shift", "8", "alt+shift", "8"),
            switch_to_tab9: chord("alt+shift", "9", "alt+shift", "9"),
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
        assert_eq!(parsed.bindings.scroll_terminal_bottom.mac.key, "end");
        assert_eq!(parsed.bindings.scroll_terminal_bottom.linux.key, "end");
        assert_eq!(parsed.bindings.switch_to_worktree1.mac.key, "1");
        assert_eq!(
            parsed.bindings.switch_to_worktree1.linux.modifiers,
            [KeybindingChordModifiersItem::Ctrl]
        );
        assert_eq!(
            parsed.bindings.switch_to_tab1.mac.modifiers,
            [
                KeybindingChordModifiersItem::Alt,
                KeybindingChordModifiersItem::Shift
            ]
        );
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
    fn load_or_ensure_reads_back_a_hand_edited_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut config = default_config();
        config.bindings.new_terminal_tab.mac.key = "n".to_string();
        std::fs::create_dir_all(config_path(home).parent().unwrap()).unwrap();
        std::fs::write(
            config_path(home),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();
        let loaded = load_or_ensure(home).unwrap();
        assert_eq!(loaded.bindings.new_terminal_tab.mac.key, "n");
    }

    #[test]
    fn project_layer_overrides_the_global_one_per_platform() {
        let global = serde_json::json!({
            "bindings": {
                "clearTerminal": {
                    "mac": { "modifiers": ["cmd", "shift"], "key": "k" }
                }
            }
        })
        .to_string();
        let project = serde_json::json!({
            "bindings": {
                "newTerminalTab": {
                    "mac": { "modifiers": ["cmd"], "key": "n" }
                }
            }
        })
        .to_string();

        let config = effective(&global, Some(&project)).unwrap();

        assert_eq!(config.bindings.new_terminal_tab.mac.key, "n");
        // The global override survives, and the untouched Linux chord stays default.
        assert_eq!(
            config.bindings.clear_terminal.mac.modifiers,
            [
                KeybindingChordModifiersItem::Cmd,
                KeybindingChordModifiersItem::Shift
            ]
        );
        assert_eq!(config.bindings.new_terminal_tab.linux.key, "t");
    }

    #[test]
    fn empty_and_absent_layers_fall_back_to_defaults() {
        let config = effective("", None).unwrap();
        assert_eq!(config.bindings.new_terminal_tab.mac.key, "t");
        assert_eq!(
            serde_json::to_value(effective("   ", Some("")).unwrap()).unwrap(),
            serde_json::to_value(&config).unwrap()
        );
    }

    #[test]
    fn validate_overrides_rejects_unusable_files() {
        assert!(validate_overrides("not json").is_err());
        assert!(validate_overrides("[]").is_err());
        assert!(validate_overrides(
            &serde_json::json!({ "bindings": { "clearTerminal": 5 } }).to_string()
        )
        .is_err());
        assert!(validate_overrides("{}").is_ok());
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
