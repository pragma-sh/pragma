//! Project script config: the `.pragma/scripts.json` contract.
//!
//! Parsing and validation live here, in the host boundary, because both the
//! desktop and `pragma-server` need them — the desktop to render its script
//! buttons, the server to run a script a phone asked for with no desktop
//! window open. A second parser would mean two definitions of what a valid
//! `scripts.json` is, and a script that runs on one device and not the other.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CoreError, CoreResult};

/// A validated project script config.
///
/// `runScripts` commands stay as JSON: the split tree they may carry describes
/// desktop panes, and this layer validates its shape without interpreting it.
/// A `BTreeMap` rather than `serde_json::Map` so the button order is
/// deterministic (alphabetical) instead of following file order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectScripts {
    #[serde(default)]
    pub setup: Vec<String>,
    #[serde(rename = "runScripts", default)]
    pub run_scripts: BTreeMap<String, ScriptDefinition>,
    #[serde(default)]
    pub teardown: Vec<String>,
}

/// One named interactive script: its commands and the header button's icon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptDefinition {
    pub command: Vec<Value>,
    pub icon: Option<String>,
}

/// Script operations served by the host that owns the terminals.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ScriptsRequest {
    /// Lists the project's named run scripts, and which of them are running in
    /// this worktree. Reading the config from the *project root* is deliberate:
    /// a child worktree is a checkout that may predate the script being added,
    /// and running a stale copy of a script is worse than running none.
    List { worktree_id: String },
    /// Starts a named script in a worktree, or returns the run already going.
    Run {
        worktree_id: String,
        name: String,
        request_id: String,
    },
    /// Ends a run and the terminals it opened.
    Stop { run_id: String },
}

/// One named script as a client renders it: what it is, and whether it is going.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptListing {
    pub name: String,
    pub icon: Option<String>,
    /// How many terminals the script opens. More than one becomes several rows
    /// on a phone rather than a split, which is a desktop layout.
    pub command_count: usize,
    /// The live run, when this script is already going in this worktree.
    pub run: Option<ScriptRun>,
}

/// A live script run: its terminals, in the order the script names them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    pub run_id: String,
    pub worktree_id: String,
    pub name: String,
    pub tab_ids: Vec<String>,
}

/// Response of `scripts`/`list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptListResult {
    pub scripts: Vec<ScriptListing>,
    /// Why the config could not be read, when it exists but is malformed. An
    /// empty list plus an error is a different state from a project with no
    /// scripts, and a client must not render them the same way.
    pub error: Option<String>,
}

/// Parses and validates a `scripts.json` body. `path` is used only in errors.
pub fn parse_config(raw: &str, path: &Path) -> CoreResult<ProjectScripts> {
    let value: Value = serde_json::from_str(raw).map_err(|error| {
        CoreError::InvalidPayload(format!("{} is not valid JSON: {error}", path.display()))
    })?;
    validate_config(&value, path)?;
    config_from_value(&value)
}

/// Flattens a named script's entries into the commands it runs, in order.
///
/// The split tree is deliberately not interpreted here: panes are a desktop
/// concept, and a phone runs the same commands without one. What both need is
/// the same command list in the same order, so a run started from either device
/// is the same run.
pub fn flatten_commands(entries: &[Value]) -> CoreResult<Vec<String>> {
    let mut commands = Vec::new();
    for entry in entries {
        push_commands(entry, &mut commands)?;
    }
    Ok(commands)
}

fn push_commands(node: &Value, commands: &mut Vec<String>) -> CoreResult<()> {
    if let Some(command) = node.as_str() {
        commands.push(command.to_string());
        return Ok(());
    }
    let object = node
        .as_object()
        .ok_or_else(|| CoreError::InvalidPayload("expected a command or split node".to_string()))?;
    // Reading order, which is also the order the desktop lays the panes out.
    for key in ["left", "right", "top", "bottom"] {
        if let Some(child) = object.get(key) {
            push_commands(child, commands)?;
        }
    }
    Ok(())
}

fn config_from_value(value: &Value) -> CoreResult<ProjectScripts> {
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload("project script config must contain a JSON object".to_string())
    })?;
    Ok(ProjectScripts {
        setup: string_array_from_value(object.get("setup"))?,
        run_scripts: runscripts_from_value(object.get("runScripts"))?,
        teardown: string_array_from_value(object.get("teardown"))?,
    })
}

fn runscripts_from_value(value: Option<&Value>) -> CoreResult<BTreeMap<String, ScriptDefinition>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::InvalidPayload("runScripts must be a JSON object".to_string()))?;
    object
        .iter()
        .map(|(name, entry)| Ok((name.clone(), script_definition_from_value(entry, name)?)))
        .collect()
}

fn script_definition_from_value(value: &Value, name: &str) -> CoreResult<ScriptDefinition> {
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload(format!("runScripts.{name} must be a JSON object"))
    })?;
    let command = interactive_array_from_value(object.get("command"))?;
    let icon = match object.get("icon") {
        None | Some(Value::Null) => None,
        Some(Value::String(icon)) => Some(icon.clone()),
        Some(_) => {
            return Err(CoreError::InvalidPayload(format!(
                "runScripts.{name}.icon must be a string"
            )))
        }
    };
    Ok(ScriptDefinition { command, icon })
}

fn interactive_array_from_value(value: Option<&Value>) -> CoreResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .cloned()
        .ok_or_else(|| CoreError::InvalidPayload("expected script command array".to_string()))
}

fn string_array_from_value(value: Option<&Value>) -> CoreResult<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| CoreError::InvalidPayload("expected script command array".to_string()))?
        .iter()
        .map(|entry| {
            entry.as_str().map(ToString::to_string).ok_or_else(|| {
                CoreError::InvalidPayload("expected script command string".to_string())
            })
        })
        .collect()
}

fn validate_config(value: &Value, path: &Path) -> CoreResult<()> {
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload(format!("{} must contain a JSON object", path.display()))
    })?;
    for key in object.keys() {
        if !matches!(key.as_str(), "setup" | "runScripts" | "teardown") {
            return Err(CoreError::InvalidPayload(format!(
                "{} has unknown key `{key}`",
                path.display()
            )));
        }
    }
    validate_command_array(object.get("setup"), path, "setup")?;
    validate_command_array(object.get("teardown"), path, "teardown")?;
    validate_runscripts(object.get("runScripts"), path)?;
    Ok(())
}

fn validate_runscripts(value: Option<&Value>, path: &Path) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload(format!("{}.runScripts must be an object", path.display()))
    })?;
    for (name, entry) in object {
        let field = format!("runScripts.{name}");
        let entry_object = entry.as_object().ok_or_else(|| {
            CoreError::InvalidPayload(format!("{}.{field} must be an object", path.display()))
        })?;
        for key in entry_object.keys() {
            if !matches!(key.as_str(), "command" | "icon") {
                return Err(CoreError::InvalidPayload(format!(
                    "{}.{field} has unknown key `{key}`",
                    path.display()
                )));
            }
        }
        validate_interactive_script_array(
            entry_object.get("command"),
            path,
            &format!("{field}.command"),
        )?;
        if let Some(icon) = entry_object.get("icon") {
            if !icon.is_null() && !icon.is_string() {
                return Err(CoreError::InvalidPayload(format!(
                    "{}.{field}.icon must be a string",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

fn validate_interactive_script_array(
    value: Option<&Value>,
    path: &Path,
    field: &str,
) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let entries = value.as_array().ok_or_else(|| {
        CoreError::InvalidPayload(format!("{}.{field} must be an array", path.display()))
    })?;
    for (index, entry) in entries.iter().enumerate() {
        validate_interactive_script_node(entry, path, &format!("{field}[{index}]"))?;
    }
    Ok(())
}

fn validate_command_array(value: Option<&Value>, path: &Path, field: &str) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let commands = value.as_array().ok_or_else(|| {
        CoreError::InvalidPayload(format!("{}.{field} must be an array", path.display()))
    })?;
    for (index, command) in commands.iter().enumerate() {
        validate_command(command, path, &format!("{field}[{index}]"))?;
    }
    Ok(())
}

fn validate_interactive_script_node(value: &Value, path: &Path, field: &str) -> CoreResult<()> {
    if value.is_string() {
        return validate_command(value, path, field);
    }
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload(format!(
            "{}.{field} must be a command string or split object",
            path.display()
        ))
    })?;
    let has_horizontal = object.contains_key("left") || object.contains_key("right");
    let has_vertical = object.contains_key("top") || object.contains_key("bottom");
    if has_horizontal == has_vertical {
        return Err(CoreError::InvalidPayload(format!(
            "{}.{field} must use exactly one split axis: left/right or top/bottom",
            path.display()
        )));
    }
    let expected = if has_horizontal {
        ["left", "right"]
    } else {
        ["top", "bottom"]
    };
    for key in object.keys() {
        if !expected.contains(&key.as_str()) {
            return Err(CoreError::InvalidPayload(format!(
                "{}.{field} has unknown key `{key}`",
                path.display()
            )));
        }
    }
    for key in expected {
        let child = object.get(key).ok_or_else(|| {
            CoreError::InvalidPayload(format!("{}.{field}.{key} is required", path.display()))
        })?;
        validate_interactive_script_node(child, path, &format!("{field}.{key}"))?;
    }
    Ok(())
}

fn validate_command(value: &Value, path: &Path, field: &str) -> CoreResult<()> {
    let command = value.as_str().ok_or_else(|| {
        CoreError::InvalidPayload(format!(
            "{}.{field} must be a command string",
            path.display()
        ))
    })?;
    if command.trim().is_empty() {
        return Err(CoreError::InvalidPayload(format!(
            "{}.{field} must not be empty",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{flatten_commands, parse_config};

    fn path() -> &'static Path {
        Path::new("/repo/.pragma/scripts.json")
    }

    #[test]
    fn parses_named_scripts_in_a_stable_order() {
        let config = parse_config(
            r#"{"runScripts":{"web":{"command":["bun dev"]},"api":{"command":["cargo run"],"icon":"server"}}}"#,
            path(),
        )
        .expect("a valid config parses");

        // Alphabetical, not file order: the header buttons must not move
        // because someone reordered the JSON.
        let names: Vec<&str> = config.run_scripts.keys().map(String::as_str).collect();
        assert_eq!(names, ["api", "web"]);
        assert_eq!(config.run_scripts["api"].icon.as_deref(), Some("server"));
    }

    #[test]
    fn a_missing_section_is_empty_rather_than_an_error() {
        let config = parse_config("{}", path()).expect("an empty object is a valid config");

        assert!(config.setup.is_empty());
        assert!(config.run_scripts.is_empty());
        assert!(config.teardown.is_empty());
    }

    #[test]
    fn names_the_offending_key_when_the_config_is_wrong() {
        let error = parse_config(r#"{"runScrpits":{}}"#, path()).expect_err("a typo is an error");

        assert!(
            error.to_string().contains("runScrpits"),
            "the message must name the key the user actually wrote: {error}"
        );
    }

    #[test]
    fn rejects_a_split_that_mixes_axes() {
        let error = parse_config(
            r#"{"runScripts":{"dev":{"command":[{"left":"a","top":"b"}]}}}"#,
            path(),
        )
        .expect_err("a two-axis split is ambiguous");

        assert!(error.to_string().contains("exactly one split axis"));
    }

    #[test]
    fn rejects_an_empty_command() {
        let error = parse_config(r#"{"runScripts":{"dev":{"command":["  "]}}}"#, path())
            .expect_err("a blank command is a mistake, not a no-op");

        assert!(error.to_string().contains("must not be empty"));
    }

    #[test]
    fn flattens_a_split_tree_in_reading_order() {
        let entries = vec![
            json!("bun dev"),
            json!({ "left": "cargo run", "right": { "top": "tail -f a", "bottom": "tail -f b" } }),
        ];

        let commands = flatten_commands(&entries).expect("a valid tree flattens");

        // The order is the contract: a phone lists these as rows, the desktop
        // lays them out as panes, and they have to name the same commands.
        assert_eq!(commands, ["bun dev", "cargo run", "tail -f a", "tail -f b"]);
    }

    #[test]
    fn flattening_rejects_a_node_that_is_neither_command_nor_split() {
        assert!(flatten_commands(&[json!(42)]).is_err());
    }
}
