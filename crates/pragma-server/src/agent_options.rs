//! Applies a launch's mode, permission mode, and slash command against a
//! catalog agent entry. Mirrors `agentLaunchArgs`/`applySlashCommand` in
//! `@pragma-sh/plugin`, which the desktop uses for the same selection.

use serde_json::Value;

/// The launch-time choices beyond model/reasoning. `None` selects the agent's
/// default: the first declared mode and permission mode, and no slash command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentLaunchOptions {
    pub mode_id: Option<String>,
    pub permission_mode_id: Option<String>,
    pub slash_command: Option<String>,
}

/// Args for the selected mode, then the selected permission mode, taken from
/// the catalog's resolved `launch.modeArgs` / `launch.permissionModeArgs`.
pub fn option_args(agent: &Value, options: &AgentLaunchOptions) -> Result<Vec<String>, String> {
    let mut args = selected_args(
        agent,
        "modes",
        "modeArgs",
        options.mode_id.as_deref(),
        "mode",
    )?;
    args.extend(selected_args(
        agent,
        "permissionModes",
        "permissionModeArgs",
        options.permission_mode_id.as_deref(),
        "permission mode",
    )?);
    Ok(args)
}

/// The prompt to prefill: the slash command's invocation followed by the
/// user's input, or the input unchanged when no command is selected.
pub fn launch_prompt(
    agent: &Value,
    slash_command: Option<&str>,
    prompt: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(name) = slash_command.filter(|name| !name.is_empty()) else {
        return Ok(prompt.map(str::to_string));
    };
    let command = agent["slashCommands"]
        .as_array()
        .and_then(|commands| commands.iter().find(|command| command["name"] == name))
        .ok_or_else(|| format!("unknown slash command: {name}"))?;
    let invocation = command["invocation"]
        .as_str()
        .map_or_else(|| format!("/{name}"), str::to_string);
    Ok(Some(
        match prompt.map(str::trim).filter(|rest| !rest.is_empty()) {
            Some(rest) => format!("{invocation} {rest}"),
            None => invocation,
        },
    ))
}

fn selected_args(
    agent: &Value,
    list_key: &str,
    args_key: &str,
    selected: Option<&str>,
    label: &str,
) -> Result<Vec<String>, String> {
    let list = agent[list_key].as_array().map_or(&[][..], Vec::as_slice);
    let id = match selected {
        Some(id) => {
            if !list.iter().any(|item| item["id"] == id) {
                return Err(format!("unknown {label}: {id}"));
            }
            id
        }
        None => match list.first().and_then(|item| item["id"].as_str()) {
            Some(id) => id,
            None => return Ok(Vec::new()),
        },
    };
    let Some(entry) = agent["launch"][args_key]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["id"] == id))
    else {
        return Ok(Vec::new());
    };
    entry["args"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|arg| {
            arg.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{label} args contain a non-string"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn agent() -> Value {
        json!({
            "modes": [{ "id": "build", "name": "Build" }, { "id": "plan", "name": "Plan" }],
            "permissionModes": [{ "id": "auto", "name": "Auto" }, { "id": "ask", "name": "Ask" }],
            "slashCommands": [
                { "name": "review" },
                { "name": "fix", "invocation": "/prompts:fix" }
            ],
            "launch": {
                "modeArgs": [
                    { "id": "build", "args": ["--agent", "build"] },
                    { "id": "plan", "args": ["--agent", "plan"] }
                ],
                "permissionModeArgs": [
                    { "id": "auto", "args": ["--yolo"] },
                    { "id": "ask", "args": [] }
                ]
            }
        })
    }

    fn options(mode: Option<&str>, permission: Option<&str>) -> AgentLaunchOptions {
        AgentLaunchOptions {
            mode_id: mode.map(str::to_string),
            permission_mode_id: permission.map(str::to_string),
            slash_command: None,
        }
    }

    #[test]
    fn defaults_to_the_first_mode_and_permission_mode() {
        assert_eq!(
            option_args(&agent(), &AgentLaunchOptions::default()).unwrap(),
            ["--agent", "build", "--yolo"]
        );
    }

    #[test]
    fn applies_selected_options_in_order() {
        assert_eq!(
            option_args(&agent(), &options(Some("plan"), Some("ask"))).unwrap(),
            ["--agent", "plan"]
        );
    }

    #[test]
    fn rejects_unknown_options() {
        assert!(option_args(&agent(), &options(Some("nope"), None)).is_err());
        assert!(option_args(&agent(), &options(None, Some("nope"))).is_err());
    }

    #[test]
    fn agents_without_options_add_no_args() {
        assert!(
            option_args(&json!({ "launch": {} }), &AgentLaunchOptions::default())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn composes_slash_command_prompts() {
        let agent = agent();
        assert_eq!(
            launch_prompt(&agent, Some("review"), Some(" pr 12 ")).unwrap(),
            Some("/review pr 12".to_string())
        );
        assert_eq!(
            launch_prompt(&agent, Some("fix"), None).unwrap(),
            Some("/prompts:fix".to_string())
        );
        assert_eq!(
            launch_prompt(&agent, None, Some("hi")).unwrap(),
            Some("hi".to_string())
        );
        assert!(launch_prompt(&agent, Some("missing"), None).is_err());
    }
}
