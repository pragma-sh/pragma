//! `agent start` and `agent options`: launch a catalog agent through the
//! gateway's `agentSessionLaunch` route, and list what it can start with.

use pragma_constants::CatalogAgent;
use serde_json::json;

use crate::agent_verify::gateway::{HttpVerifyApi, LaunchSpec, VerifyApi};
use crate::agent_verify::{project_for_worktree, resolve_agent};
use crate::cli::{AgentOptionsArgs, AgentStartArgs};
use crate::output::Output;
use crate::server::{self, CliError};

/// Starts an agent in a new tab of a worktree, validating every selection
/// against the catalog first so a typo fails here rather than in the TUI.
pub fn start(args: &AgentStartArgs, out: &Output) -> Result<(), CliError> {
    let api = HttpVerifyApi::discover().map_err(CliError::config)?;
    let catalog = api.catalog().map_err(CliError::config)?;
    let agent = resolve_agent(&catalog.agents, &args.agent).map_err(CliError::config)?;
    validate_selection(agent, args).map_err(CliError::config)?;
    let worktree_id = server::worktree_id(args.worktree.clone())?;
    let workspace = api.workspace_snapshot().map_err(CliError::config)?;
    let project_id = project_for_worktree(&workspace, &worktree_id).map_err(CliError::config)?;
    let launched = api
        .launch(&LaunchSpec {
            project_id: &project_id,
            worktree_id: &worktree_id,
            agent_id: &agent.id,
            model_id: args.model.as_deref(),
            reasoning_id: args.reasoning.as_deref(),
            model_cmd: None,
            mode_id: args.mode.as_deref(),
            permission_mode_id: args.permission_mode.as_deref(),
            slash_command: args.slash_command.as_deref(),
            headless: args.headless,
            prompt: args.prompt.as_deref().unwrap_or_default(),
        })
        .map_err(CliError::server)?;
    let value = json!({
        "agent": agent.id,
        "worktreeId": launched.worktree_id,
        "tabId": launched.tab_id,
    });
    out.line(
        format!(
            "started {} in {} tab={}",
            agent.id, launched.worktree_id, launched.tab_id
        ),
        &value,
    );
    Ok(())
}

/// Prints an agent's models, modes, permission modes, and slash commands.
pub fn options(args: &AgentOptionsArgs, out: &Output) -> Result<(), CliError> {
    let api = HttpVerifyApi::discover().map_err(CliError::config)?;
    let catalog = api.catalog().map_err(CliError::config)?;
    let agent = resolve_agent(&catalog.agents, &args.agent).map_err(CliError::config)?;
    let rows = option_rows(agent);
    let value = json!({
        "agent": agent.id,
        "models": agent.models,
        "modes": agent.modes,
        "permissionModes": agent.permission_modes,
        "slashCommands": agent.slash_commands,
    });
    out.list(
        ["KIND", "ID", "DESCRIPTION"],
        &rows,
        |(kind, id, description)| [kind.clone(), id.clone(), description.clone()],
        &value,
    );
    Ok(())
}

/// One `(kind, id, description)` row per selectable option; the first mode and
/// permission mode are marked as the defaults a launch applies.
fn option_rows(agent: &CatalogAgent) -> Vec<(String, String, String)> {
    let mut rows = Vec::new();
    for model in &agent.models {
        let reasoning = model
            .reasoning
            .iter()
            .map(|level| level.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        rows.push((
            "model".to_string(),
            model.id.clone(),
            if reasoning.is_empty() {
                model.name.clone()
            } else {
                format!("{} (reasoning: {reasoning})", model.name)
            },
        ));
    }
    for (index, mode) in agent.modes.iter().enumerate() {
        rows.push((
            "mode".to_string(),
            mode.id.clone(),
            with_default(&mode.name, index),
        ));
    }
    for (index, mode) in agent.permission_modes.iter().enumerate() {
        rows.push((
            "permission-mode".to_string(),
            mode.id.clone(),
            with_default(&mode.name, index),
        ));
    }
    for command in &agent.slash_commands {
        let hint = command.argument_hint.as_deref().unwrap_or_default();
        let description = command.description.as_deref().unwrap_or_default();
        rows.push((
            "slash-command".to_string(),
            format!("/{} {hint}", command.name).trim_end().to_string(),
            description.to_string(),
        ));
    }
    rows
}

fn with_default(name: &str, index: usize) -> String {
    if index == 0 {
        format!("{name} (default)")
    } else {
        name.to_string()
    }
}

fn validate_selection(agent: &CatalogAgent, args: &AgentStartArgs) -> Result<(), String> {
    if let Some(model_id) = args.model.as_deref() {
        let model = agent
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| format!("model not found for {}: {model_id}", agent.id))?;
        if let Some(reasoning) = args.reasoning.as_deref() {
            if !model.reasoning.iter().any(|level| level.id == reasoning) {
                return Err(format!("reasoning not offered by {model_id}: {reasoning}"));
            }
        }
    } else if args.reasoning.is_some() {
        return Err("--reasoning requires --model".to_string());
    }
    require_listed(
        "mode",
        args.mode.as_deref(),
        agent.modes.iter().map(|mode| mode.id.as_str()),
    )?;
    require_listed(
        "permission mode",
        args.permission_mode.as_deref(),
        agent.permission_modes.iter().map(|mode| mode.id.as_str()),
    )?;
    require_listed(
        "slash command",
        args.slash_command.as_deref(),
        agent
            .slash_commands
            .iter()
            .map(|command| command.name.as_str()),
    )
}

fn require_listed<'a>(
    label: &str,
    requested: Option<&str>,
    mut offered: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    match requested {
        Some(id) if !offered.any(|candidate| candidate == id) => Err(format!(
            "unknown {label}: {id} (see `pragma-cli agent options`)"
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> CatalogAgent {
        serde_json::from_value(json!({
            "id": "pragma.demo",
            "name": "Demo",
            "pluginId": "pragma.demo",
            "models": [{ "id": "m", "name": "M", "reasoning": [{ "id": "high", "name": "High" }] }],
            "modes": [{ "id": "build", "name": "Build" }, { "id": "plan", "name": "Plan" }],
            "permissionModes": [{ "id": "auto", "name": "Auto" }],
            "slashCommands": [{ "name": "review", "argumentHint": "[pr]", "description": "Review" }],
            "launch": { "commands": [] }
        }))
        .unwrap()
    }

    fn start_args() -> AgentStartArgs {
        AgentStartArgs {
            worktree: None,
            agent: "demo".to_string(),
            model: None,
            reasoning: None,
            mode: None,
            permission_mode: None,
            slash_command: None,
            prompt: None,
            headless: false,
        }
    }

    #[test]
    fn accepts_listed_options() {
        let args = AgentStartArgs {
            model: Some("m".to_string()),
            reasoning: Some("high".to_string()),
            mode: Some("plan".to_string()),
            permission_mode: Some("auto".to_string()),
            slash_command: Some("review".to_string()),
            ..start_args()
        };
        assert!(validate_selection(&agent(), &args).is_ok());
    }

    #[test]
    fn rejects_unlisted_options() {
        for args in [
            AgentStartArgs {
                mode: Some("nope".to_string()),
                ..start_args()
            },
            AgentStartArgs {
                slash_command: Some("nope".to_string()),
                ..start_args()
            },
            AgentStartArgs {
                reasoning: Some("high".to_string()),
                ..start_args()
            },
        ] {
            assert!(validate_selection(&agent(), &args).is_err());
        }
    }

    #[test]
    fn marks_defaults_in_option_rows() {
        let rows = option_rows(&agent());
        assert!(rows.contains(&(
            "mode".to_string(),
            "build".to_string(),
            "Build (default)".to_string()
        )));
        assert!(rows.contains(&(
            "slash-command".to_string(),
            "/review [pr]".to_string(),
            "Review".to_string()
        )));
    }
}
