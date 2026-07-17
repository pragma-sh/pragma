//! End-to-end agent plugin verification through gateway HTTP + mobile NDJSON.

mod engine;
mod events;
mod gateway;
mod prompts;
mod report;
mod scenarios;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use pragma_constants::{CatalogAgent, WorkspaceSnapshot};

use crate::cli::AgentVerifyArgs;
use crate::output::Output;
use crate::server::CliError;

use engine::ScenarioCtx;
use events::Ledger;
use gateway::{HttpVerifyApi, VerifyApi};
use prompts::{parse_escapes, Prompts};
use report::{ScenarioResult, ScenarioStatus, VerifyReport};
use scenarios::{definitions, Outcome};

/// Runs catalog gate and selected real-agent scenarios.
pub fn run(args: &AgentVerifyArgs, out: &Output) -> Result<(), CliError> {
    let api = HttpVerifyApi::discover().map_err(CliError::config)?;
    let catalog = api.catalog().map_err(CliError::config)?;
    let catalog_agent = resolve_agent(&catalog.agents, &args.agent).map_err(CliError::config)?;
    let mut results = vec![catalog_result(&api, catalog_agent)];
    if matches!(results[0].status, ScenarioStatus::Failed) {
        return finish(out, args.agent.clone(), results, Vec::new());
    }

    validate_scenario_filters(&args.scenarios).map_err(CliError::config)?;
    if args.scenarios == ["catalog"] {
        return finish(out, args.agent.clone(), results, Vec::new());
    }
    let prompts = Prompts::load(args.prompts.as_deref()).map_err(CliError::config)?;
    let abort_input = parse_escapes(&args.abort_input).map_err(CliError::config)?;
    if abort_input.is_empty() {
        return Err(CliError::config(
            "--abort-input must not decode to empty bytes",
        ));
    }
    let worktree_id = crate::server::worktree_id(args.worktree.clone())?;
    let workspace = api.workspace_snapshot().map_err(CliError::config)?;
    let project_id = project_for_worktree(&workspace, &worktree_id).map_err(CliError::config)?;
    let model_cmd = resolve_model_cmd(args.pick_model_cmd.as_deref()).map_err(CliError::config)?;
    let model_id = if model_cmd.is_some() {
        None
    } else {
        Some(resolve_model(catalog_agent, args.model.as_deref()).map_err(CliError::config)?)
    };
    let runtime_agent_id = runtime_agent_id(&catalog_agent.id);
    let ledger = Ledger::collect(api.event_reader().map_err(CliError::config)?);
    let selected: HashSet<&str> = args.scenarios.iter().map(String::as_str).collect();
    let context = ScenarioCtx {
        api: &api,
        ledger: &ledger,
        project_id: &project_id,
        worktree_id: &worktree_id,
        catalog_agent_id: &catalog_agent.id,
        plugin_id: &catalog_agent.plugin_id,
        runtime_agent_id: &runtime_agent_id,
        model_id,
        model_cmd,
        timeout: Duration::from_secs(args.step_timeout),
        abort_input: &abort_input,
    };

    for scenario in definitions() {
        if !selected.is_empty() && !selected.contains(scenario.id) {
            continue;
        }
        if scenario.slow && !args.include_slow {
            results.push(skipped_result(scenario, "requires --include-slow"));
            continue;
        }
        let result = execute_scenario(scenario, &context, &prompts, args.attempts);
        let failed = matches!(result.status, ScenarioStatus::Failed);
        results.push(result);
        if args.fail_fast && failed {
            break;
        }
    }

    finish(out, args.agent.clone(), results, ledger.schema_errors())
}

fn execute_scenario(
    scenario: &scenarios::ScenarioDef,
    context: &ScenarioCtx<'_>,
    prompts: &Prompts,
    configured_attempts: u32,
) -> ScenarioResult {
    let started = Instant::now();
    let first_cursor = context.ledger.cursor();
    let attempts = if scenario.id == "stream-integrity" {
        1
    } else {
        configured_attempts
    };
    let mut failure = None;
    let mut completed_attempts = 0;
    let mut status = ScenarioStatus::Failed;
    for attempt in 1..=attempts {
        completed_attempts = attempt;
        match (scenario.run)(context, prompts) {
            Ok(Outcome::Passed) => {
                status = ScenarioStatus::Passed;
                failure = None;
                break;
            }
            Ok(Outcome::Skipped(reason)) => {
                status = ScenarioStatus::Skipped;
                failure = Some(reason);
                break;
            }
            Err(error) => failure = Some(error),
        }
    }
    let evidence = context.ledger.evidence_since(first_cursor, 8);
    ScenarioResult {
        id: scenario.id.to_string(),
        name: scenario.name.to_string(),
        status,
        attempts: completed_attempts,
        duration_ms: started.elapsed().as_millis(),
        failure,
        evidence,
    }
}

fn skipped_result(scenario: &scenarios::ScenarioDef, reason: &str) -> ScenarioResult {
    ScenarioResult {
        id: scenario.id.to_string(),
        name: scenario.name.to_string(),
        status: ScenarioStatus::Skipped,
        attempts: 0,
        duration_ms: 0,
        failure: Some(reason.to_string()),
        evidence: Vec::new(),
    }
}

fn catalog_result(api: &dyn VerifyApi, agent: &CatalogAgent) -> ScenarioResult {
    let started = Instant::now();
    let result = validate_catalog_agent(api, agent);
    ScenarioResult {
        id: "catalog".to_string(),
        name: "catalog gate".to_string(),
        status: if result.is_ok() {
            ScenarioStatus::Passed
        } else {
            ScenarioStatus::Failed
        },
        attempts: 1,
        duration_ms: started.elapsed().as_millis(),
        failure: result.err(),
        evidence: Vec::new(),
    }
}

fn validate_catalog_agent(api: &dyn VerifyApi, agent: &CatalogAgent) -> Result<(), String> {
    if agent.models.is_empty() {
        return Err("catalog agent has no models".to_string());
    }
    if agent.launch.commands.is_empty()
        || agent
            .launch
            .commands
            .iter()
            .any(|command| command.command.is_empty())
    {
        return Err("catalog agent has empty launch command".to_string());
    }
    let icon = agent
        .icon
        .as_ref()
        .ok_or_else(|| "catalog agent has no icon".to_string())?;
    api.asset_exists(&icon.hash)
}

fn resolve_agent<'a>(
    agents: &'a [CatalogAgent],
    requested: &str,
) -> Result<&'a CatalogAgent, String> {
    let mut matches = agents
        .iter()
        .filter(|agent| agent.id == requested || agent.id.ends_with(&format!(".{requested}")));
    let first = matches
        .next()
        .ok_or_else(|| format!("agent not found in catalog: {requested}"))?;
    if matches.next().is_some() {
        return Err(format!(
            "agent id is ambiguous; pass qualified catalog id: {requested}"
        ));
    }
    Ok(first)
}

fn resolve_model<'a>(agent: &'a CatalogAgent, requested: Option<&str>) -> Result<&'a str, String> {
    if let Some(requested) = requested {
        return agent
            .models
            .iter()
            .find(|model| model.id == requested)
            .map(|model| model.id.as_str())
            .ok_or_else(|| format!("model not found for {}: {requested}", agent.id));
    }
    agent
        .models
        .first()
        .map(|model| model.id.as_str())
        .ok_or_else(|| format!("agent {} has no models", agent.id))
}

/// Normalizes `--pick-model-cmd`: blank/whitespace-only values are rejected so
/// a quoted empty flag cannot silently launch the agent's default model.
fn resolve_model_cmd(requested: Option<&str>) -> Result<Option<&str>, String> {
    match requested {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Err("--pick-model-cmd must not be empty".to_string())
            } else {
                Ok(Some(trimmed))
            }
        }
    }
}

fn project_for_worktree(snapshot: &WorkspaceSnapshot, worktree_id: &str) -> Result<String, String> {
    let project_id = snapshot
        .worktrees
        .iter()
        .find(|worktree| worktree.id == worktree_id)
        .map(|worktree| worktree.project_id.clone())
        .ok_or_else(|| {
            format!(
                "worktree {worktree_id} is absent from workspace snapshot; open project in Pragma once"
            )
        })?;
    if snapshot
        .projects
        .iter()
        .any(|project| project.id == project_id)
    {
        Ok(project_id)
    } else {
        Err(format!(
            "project {project_id} is absent from workspace snapshot"
        ))
    }
}

/// Final segment of the resolved catalog id — the id chat consumers (mobile
/// `runtimeAgentId`, watcher `agentId`) filter the event stream by. Verify
/// scopes events by this id ONLY: a plugin reporting under any other id (for
/// example the qualified catalog id) is invisible to those consumers, and
/// accepting aliases here would hide exactly that bug.
fn runtime_agent_id(catalog_id: &str) -> String {
    catalog_id
        .rsplit('.')
        .next()
        .unwrap_or(catalog_id)
        .to_string()
}

fn validate_scenario_filters(filters: &[String]) -> Result<(), String> {
    let known: HashSet<&str> = definitions()
        .iter()
        .map(|scenario| scenario.id)
        .chain(["catalog"])
        .collect();
    let unknown: Vec<&str> = filters
        .iter()
        .map(String::as_str)
        .filter(|id| !known.contains(id))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!("unknown scenarios: {}", unknown.join(", ")))
    }
}

fn finish(
    out: &Output,
    agent: String,
    scenarios: Vec<ScenarioResult>,
    schema_errors: Vec<String>,
) -> Result<(), CliError> {
    let passed = schema_errors.is_empty()
        && scenarios
            .iter()
            .all(|result| !matches!(result.status, ScenarioStatus::Failed));
    let report = VerifyReport {
        agent,
        passed,
        scenarios,
        schema_errors,
    };
    out.list(
        ["scenario", "status", "attempts", "duration-ms", "failure"],
        &report.scenarios,
        |result| {
            [
                result.id.clone(),
                result.status.to_string(),
                result.attempts.to_string(),
                result.duration_ms.to_string(),
                result.failure.clone().unwrap_or_default(),
            ]
        },
        &report,
    );
    if passed {
        Ok(())
    } else {
        Err(CliError::other(
            "one or more agent verification scenarios failed",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_scenario_filters() {
        assert!(validate_scenario_filters(&["basic-reply".to_string()]).is_ok());
        assert!(validate_scenario_filters(&["missing".to_string()]).is_err());
    }

    #[test]
    fn runtime_agent_id_is_final_catalog_segment() {
        assert_eq!(runtime_agent_id("pragma.opencode"), "opencode");
        assert_eq!(runtime_agent_id("pragma.claude-code"), "claude-code");
        assert_eq!(runtime_agent_id("codex"), "codex");
    }

    #[test]
    fn resolve_model_cmd_trims_and_rejects_blank() {
        assert_eq!(resolve_model_cmd(None), Ok(None));
        assert_eq!(
            resolve_model_cmd(Some("  --model moonshot/kimi-k3 ")),
            Ok(Some("--model moonshot/kimi-k3"))
        );
        assert!(resolve_model_cmd(Some("   ")).is_err());
    }
}
