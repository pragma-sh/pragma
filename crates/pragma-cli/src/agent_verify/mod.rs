//! End-to-end agent plugin verification through gateway HTTP + mobile NDJSON.

mod engine;
mod events;
mod gateway;
mod prompts;
mod report;
mod scenarios;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
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
    // Prefill-retry inputs mirroring the host's launch behavior (see
    // `ScenarioSession::await_running`).
    let prefill_plain = serde_json::to_value(&catalog_agent.launch)
        .ok()
        .is_some_and(|launch| launch["prefillMode"] == "plain");
    let prefill_submit = catalog_agent
        .launch
        .prefill_submit
        .clone()
        .unwrap_or_else(|| "\r".to_string());
    let ledger = Ledger::collect(api.event_reader().map_err(CliError::config)?);
    let all_launched_tabs = Mutex::new(Vec::new());
    // Each scenario gets its own context so launched-tab tracking (evidence
    // scoping) stays per-scenario when scenarios run concurrently.
    let make_context = || ScenarioCtx {
        api: &api,
        ledger: &ledger,
        project_id: &project_id,
        worktree_id: &worktree_id,
        catalog_agent_id: &catalog_agent.id,
        plugin_id: &catalog_agent.plugin_id,
        runtime_agent_id: &runtime_agent_id,
        model_id,
        model_cmd,
        attempt_timeout: Duration::from_secs(args.step_timeout),
        abort_input: &abort_input,
        headless: !args.headed,
        prefill_plain,
        prefill_submit: &prefill_submit,
        launched_tabs: Mutex::new(Vec::new()),
        all_launched_tabs: &all_launched_tabs,
    };
    results.extend(run_scenarios(args, catalog_agent, &prompts, &make_context));
    if let Err(error) = clear_launched_statuses(
        &runtime_agent_id,
        &all_launched_tabs,
        |agent, worktree_id, tab_id| api.clear_status(agent, worktree_id, tab_id),
    ) {
        results.push(cleanup_failed_result(error));
    }
    finish(out, args.agent.clone(), results, ledger.schema_errors())
}

fn clear_launched_statuses(
    agent: &str,
    launched: &Mutex<Vec<gateway::LaunchResult>>,
    mut clear_status: impl FnMut(&str, &str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let tabs = launched
        .lock()
        .map_err(|_| "launched-session lock poisoned".to_string())?
        .clone();
    let mut errors = Vec::new();
    for tab in tabs {
        if let Err(error) = clear_status(agent, &tab.worktree_id, &tab.tab_id) {
            errors.push(format!("{}: {error}", tab.tab_id));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "failed to clear agent statuses: {}",
            errors.join(" | ")
        ))
    }
}

fn cleanup_failed_result(error: String) -> ScenarioResult {
    ScenarioResult {
        id: "cleanup".to_string(),
        name: "status cleanup".to_string(),
        status: ScenarioStatus::Failed,
        attempts: 1,
        duration_ms: 0,
        failure: Some(error),
        evidence: Vec::new(),
    }
}

/// Runs the selected scenarios on a bounded worker pool (`--jobs`), keeping
/// `stream-integrity` serial and last because it asserts invariants over the
/// whole event ledger. Results come back in scenario-table order.
fn run_scenarios<'a>(
    args: &AgentVerifyArgs,
    catalog_agent: &CatalogAgent,
    prompts: &Prompts,
    make_context: &(impl Fn() -> ScenarioCtx<'a> + Sync),
) -> Vec<ScenarioResult> {
    let selected: HashSet<&str> = args.scenarios.iter().map(String::as_str).collect();
    let mut queued: Vec<(usize, &scenarios::ScenarioDef)> = Vec::new();
    let mut serial: Vec<(usize, &scenarios::ScenarioDef)> = Vec::new();
    let outcomes: Mutex<Vec<(usize, ScenarioResult)>> = Mutex::new(Vec::new());
    for (index, scenario) in definitions().iter().enumerate() {
        if !selected.is_empty() && !selected.contains(scenario.id) {
            continue;
        }
        let skip_reason = if scenario.slow && !args.include_slow {
            Some("requires --include-slow")
        } else if excludes_scenario(scenario, catalog_agent.exclude_features.as_deref()) {
            Some("agent declares this feature unsupported")
        } else {
            None
        };
        if let Some(reason) = skip_reason {
            if let Ok(mut outcomes) = outcomes.lock() {
                outcomes.push((index, skipped_result(scenario, reason)));
            }
        } else if scenario.id == "stream-integrity" {
            serial.push((index, scenario));
        } else {
            queued.push((index, scenario));
        }
    }

    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let workers = usize::from(args.jobs).min(queued.len());
    if workers > 0 {
        thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    if args.fail_fast && failed.load(Ordering::SeqCst) {
                        break;
                    }
                    let slot = next.fetch_add(1, Ordering::SeqCst);
                    let Some((index, scenario)) = queued.get(slot) else {
                        break;
                    };
                    let context = make_context();
                    let result = execute_scenario(scenario, &context, prompts, args.attempts);
                    if matches!(result.status, ScenarioStatus::Failed) {
                        failed.store(true, Ordering::SeqCst);
                    }
                    if let Ok(mut outcomes) = outcomes.lock() {
                        outcomes.push((*index, result));
                    }
                });
            }
        });
    }

    if !(args.fail_fast && failed.load(Ordering::SeqCst)) {
        for (index, scenario) in serial {
            let context = make_context();
            let result = execute_scenario(scenario, &context, prompts, args.attempts);
            if let Ok(mut outcomes) = outcomes.lock() {
                outcomes.push((index, result));
            }
        }
    }

    let mut outcomes = outcomes.into_inner().unwrap_or_default();
    outcomes.sort_by_key(|(index, _)| *index);
    outcomes.into_iter().map(|(_, result)| result).collect()
}

fn excludes_scenario(
    scenario: &scenarios::ScenarioDef,
    excluded: Option<&[pragma_constants::AgentFeature]>,
) -> bool {
    excluded.is_some_and(|excluded| {
        scenario
            .features
            .iter()
            .any(|feature| excluded.contains(feature))
    })
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
    // Scope evidence to this scenario's own sessions; ledger-wide scenarios
    // (stream-integrity) launch no tabs and keep the unscoped view.
    let launched_tabs = context
        .launched_tabs
        .lock()
        .map(|tabs| tabs.clone())
        .unwrap_or_default();
    let evidence = if launched_tabs.is_empty() {
        context.ledger.evidence_since(first_cursor, 8)
    } else {
        context
            .ledger
            .evidence_since_for_tabs(first_cursor, 8, &launched_tabs)
    };
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
    use pragma_constants::{AgentCatalog, AgentFeature, CatalogAgent};

    use super::*;

    struct StubVerifyApi;

    impl VerifyApi for StubVerifyApi {
        fn catalog(&self) -> Result<AgentCatalog, String> {
            unreachable!("catalog is not called by this test")
        }
        fn asset_exists(&self, _hash: &str) -> Result<(), String> {
            Ok(())
        }
        fn workspace_snapshot(&self) -> Result<pragma_constants::WorkspaceSnapshot, String> {
            unreachable!("workspace snapshot is not called by this test")
        }
        fn launch(&self, _spec: &gateway::LaunchSpec<'_>) -> Result<gateway::LaunchResult, String> {
            unreachable!("launch is not called by this test")
        }
        fn clear_status(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
        ) -> Result<(), String> {
            unreachable!("clear status is not called by this test")
        }
        fn answer(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
            _request_id: &str,
            _answer: Option<&str>,
        ) -> Result<(), String> {
            unreachable!("answer is not called by this test")
        }
        fn decide(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
            _request_id: &str,
            _approved: bool,
        ) -> Result<(), String> {
            unreachable!("decide is not called by this test")
        }
        fn interrupt(&self, _agent: &str, _worktree_id: &str, _tab_id: &str) -> Result<(), String> {
            unreachable!("interrupt is not called by this test")
        }
        fn input(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
            _text: &str,
        ) -> Result<(), String> {
            unreachable!("input is not called by this test")
        }
        fn write_input(&self, _session_id: &str, _bytes: &[u8]) -> Result<(), String> {
            unreachable!("write input is not called by this test")
        }
        fn kill_session(&self, _session_id: &str) -> Result<(), String> {
            unreachable!("kill session is not called by this test")
        }
        fn usage_limits(&self, _plugin_id: &str) -> Result<serde_json::Value, String> {
            unreachable!("usage limits are not called by this test")
        }
        fn event_reader(&self) -> Result<Box<dyn std::io::BufRead + Send>, String> {
            unreachable!("event reader is not called by this test")
        }
    }

    fn catalog_agent(models: &[serde_json::Value]) -> CatalogAgent {
        serde_json::from_value(serde_json::json!({
            "id": "agent",
            "name": "Agent",
            "pluginId": "plugin",
            "models": models,
            "launch": {
                "commands": [{ "modelId": null, "reasoningId": null, "command": ["agent"] }]
            }
        }))
        .expect("catalog agent fixture")
    }

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
    fn catalog_gate_requires_at_least_one_model() {
        let api = StubVerifyApi;
        assert_eq!(
            validate_catalog_agent(&api, &catalog_agent(&[])).unwrap_err(),
            "catalog agent has no models"
        );
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

    #[test]
    fn excludes_scenarios_matching_any_required_feature() {
        let abort_question = definitions()
            .iter()
            .find(|scenario| scenario.id == "abort-mid-question")
            .expect("abort question scenario");
        assert!(excludes_scenario(
            abort_question,
            Some(&[AgentFeature::Abort])
        ));
        assert!(excludes_scenario(
            abort_question,
            Some(&[AgentFeature::Questions])
        ));
        assert!(!excludes_scenario(
            abort_question,
            Some(&[AgentFeature::Commands])
        ));
    }

    #[test]
    fn clears_every_launched_status_before_exit() {
        let launched = Mutex::new(vec![
            gateway::LaunchResult {
                worktree_id: "w1".to_string(),
                tab_id: "t1".to_string(),
            },
            gateway::LaunchResult {
                worktree_id: "w2".to_string(),
                tab_id: "t2".to_string(),
            },
        ]);
        let mut cleared = Vec::new();

        clear_launched_statuses("opencode", &launched, |agent, worktree, tab| {
            cleared.push((agent.to_string(), worktree.to_string(), tab.to_string()));
            Ok(())
        })
        .expect("status cleanup");

        assert_eq!(
            cleared,
            [
                ("opencode".to_string(), "w1".to_string(), "t1".to_string()),
                ("opencode".to_string(), "w2".to_string(), "t2".to_string()),
            ]
        );
    }
}
