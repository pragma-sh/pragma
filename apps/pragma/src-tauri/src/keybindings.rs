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
/// hand and survives app reinstalls.
pub fn load_or_ensure(home_dir: impl AsRef<Path>) -> AppResult<KeybindingsConfig> {
    let path = config_path(home_dir);
    if !path.exists() {
        write_defaults(&path)?;
    }
    let content = std::fs::read_to_string(&path)?;
    let config: KeybindingsConfig = serde_json::from_str(&content)?;
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

fn default_config() -> KeybindingsConfig {
    KeybindingsConfig {
        version: NonZeroU64::new(1).expect("1 is non-zero"),
        bindings: Keybindings {
            next_tab: chord("ctrl", "tab", "alt", "tab"),
            previous_tab: chord("ctrl+shift", "tab", "alt+shift", "tab"),
            close_top_tab: chord("cmd", "w", "ctrl", "w"),
            new_terminal_tab: chord("cmd", "t", "ctrl", "t"),
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
}
