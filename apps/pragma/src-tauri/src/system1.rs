//! System 1 models (`TypeSafe` Jev or any Jev-compatible API) and auto mode.
//!
//! This module owns the secret and the configuration; the request itself runs
//! in the `pragma-ai` sidecar (`packages/ai-helpers/src/auto-select.ts`), which
//! is where the benchmark catalogs it feeds the model already live.
//!
//! - The **API key** is an owner-only [`SecretFile`] under the per-instance app
//!   data dir, exactly like the GitHub token. It never crosses IPC back to the
//!   webview: the frontend can set, test, or clear it, and learn whether one is
//!   configured — nothing else.
//! - The **base URL** and **model route** are ordinary global settings in
//!   `~/.pragma/config.json` under `system1` (`System1Settings`), defaulting to
//!   `CONSTANTS.system1`.
//! - **`automode.md`** is read here for both scopes — the project copy through
//!   the owning host, so an SSH project's preferences come from that host — and
//!   handed to the sidecar verbatim.

use pragma_constants::{System1Settings, System1Status, CONSTANTS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::ai::run_oneshot;
use crate::config_file::{read_scoped, write_scoped, ConfigDocument, ConfigScope};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::secret_file::SecretFile;

/// The stored System 1 API key. Managed as Tauri state.
#[derive(Clone)]
pub struct System1KeyStore {
    file: SecretFile,
}

impl System1KeyStore {
    /// Builds the store under the per-instance app data dir.
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            file: SecretFile::new(data_dir, &CONSTANTS.system1.credential_file_name),
        }
    }
}

/// A reasoning level, lowest effort first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectReasoning {
    id: String,
    name: String,
}

/// One model an agent can launch with.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectModel {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canonical_id: Option<String>,
    #[serde(default)]
    reasoning: Vec<AutoSelectReasoning>,
}

/// One launchable agent and its models.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectAgent {
    id: String,
    name: String,
    #[serde(default)]
    models: Vec<AutoSelectModel>,
}

/// Where the launch will run, as shown to the System 1 model.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectContext {
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    worktree: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

/// What the frontend asks for: pick among `agents` for `prompt`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectInput {
    /// Project whose `automode.md` applies, if any.
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    context: AutoSelectContext,
    agents: Vec<AutoSelectAgent>,
}

/// The sidecar's pick, returned to the frontend unchanged in shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelection {
    agent_id: String,
    model_id: Option<String>,
    reasoning_id: Option<String>,
    confidence: f64,
    low_confidence: bool,
    difficulty: f64,
    agent_probabilities: std::collections::HashMap<String, f64>,
    model_probabilities: std::collections::HashMap<String, f64>,
    reason: String,
    warnings: Vec<String>,
    sources: AutoSelectionSources,
}

/// Which benchmark feeds contributed to an [`AutoSelection`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSelectionSources {
    model_benchmarks: bool,
    harness_benchmarks: bool,
}

/// Effective base URL and model: the configured value when non-blank, else the default.
fn effective_settings(settings: &System1Settings) -> (String, String) {
    let base_url = non_blank(settings.base_url.as_deref())
        .unwrap_or(&CONSTANTS.system1.default_base_url)
        .to_string();
    let model = resolve_model(settings.model.as_deref(), &base_url);
    (base_url, model)
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The model route to send: the configured one, else what the endpoint's host
/// expects (`CONSTANTS.system1.host_models` — `OpenRouter` names Jev
/// `~typesafe/jev-latest`), else the `TypeSafe` default.
fn resolve_model(configured: Option<&str>, base_url: &str) -> String {
    if let Some(model) = non_blank(configured) {
        return model.to_string();
    }
    let host = reqwest::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    host.and_then(|host| {
        CONSTANTS
            .system1
            .host_models
            .iter()
            .find(|entry| host == entry.host || host.ends_with(&format!(".{}", entry.host)))
    })
    .map_or_else(
        || CONSTANTS.system1.default_model.clone(),
        |entry| entry.model.clone(),
    )
}

/// Parses the `system1` block out of a global `config.json`. A missing or
/// malformed block reads as "all defaults" — a typo elsewhere in the file must
/// not disable auto mode.
fn settings_from_config(contents: &str) -> System1Settings {
    serde_json::from_str::<Value>(contents)
        .ok()
        .and_then(|config| config.get("system1").cloned())
        .and_then(|block| serde_json::from_value(block).ok())
        .unwrap_or_default()
}

/// Reads the `system1` block of the global `config.json`.
fn global_settings(app: &tauri::AppHandle) -> AppResult<System1Settings> {
    let path = app
        .path()
        .home_dir()?
        .join(CONSTANTS.plugins.config_file_name.as_str());
    Ok(std::fs::read_to_string(path)
        .map(|contents| settings_from_config(&contents))
        .unwrap_or_default())
}

fn status(app: &tauri::AppHandle, store: &System1KeyStore) -> AppResult<System1Status> {
    let (base_url, model) = effective_settings(&global_settings(app)?);
    Ok(System1Status {
        configured: store.file.read().is_some(),
        base_url,
        model,
    })
}

/// The endpoint object the sidecar's `@pragma-sh/system1` client takes.
fn endpoint(base_url: &str, model: &str, api_key: &str) -> Value {
    json!({
        "baseUrl": base_url,
        "evaluatePath": CONSTANTS.system1.evaluate_path,
        "apiKey": api_key,
        "model": model,
    })
}

/// The configured System 1 endpoint object, key included, for a sidecar
/// request. Errors when no key is stored.
pub(crate) fn configured_endpoint(
    app: &tauri::AppHandle,
    store: &System1KeyStore,
) -> AppResult<Value> {
    let api_key = store.file.read().ok_or_else(|| {
        AppError::InvalidInput("add a System 1 API key in Settings first".to_string())
    })?;
    let (base_url, model) = effective_settings(&global_settings(app)?);
    Ok(endpoint(&base_url, &model, &api_key))
}

/// Runs one sidecar command off the async runtime.
async fn run_sidecar(command: &'static str, stdin: String) -> AppResult<Value> {
    tauri::async_runtime::spawn_blocking(move || run_oneshot(&[command], Some(&stdin)))
        .await
        .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Whether a System 1 key is stored, and the effective endpoint. The config and
/// credential files are read on a blocking worker so the IPC handler never
/// stalls painting or terminal keystrokes.
#[tauri::command]
pub async fn system1_status(
    app: tauri::AppHandle,
    store: State<'_, System1KeyStore>,
) -> AppResult<System1Status> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status(&app, &store))
        .await
        .map_err(|error| AppError::Ai(format!("System 1 status task failed: {error}")))?
}

/// Stores the System 1 API key, returning the refreshed status. The write runs
/// off the IPC handler, like [`system1_status`].
#[tauri::command]
pub async fn system1_set_api_key(
    app: tauri::AppHandle,
    store: State<'_, System1KeyStore>,
    api_key: String,
) -> AppResult<System1Status> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::InvalidInput("API key is empty".to_string()));
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .file
            .write(&api_key)
            .map_err(|error| AppError::Ai(format!("failed to store System 1 key: {error}")))?;
        status(&app, &store)
    })
    .await
    .map_err(|error| AppError::Ai(format!("System 1 key task failed: {error}")))?
}

/// Removes the stored System 1 API key, returning the refreshed status. The
/// removal runs off the IPC handler, like [`system1_status`].
#[tauri::command]
pub async fn system1_clear_api_key(
    app: tauri::AppHandle,
    store: State<'_, System1KeyStore>,
) -> AppResult<System1Status> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .file
            .clear()
            .map_err(|error| AppError::Ai(format!("failed to clear System 1 key: {error}")))?;
        status(&app, &store)
    })
    .await
    .map_err(|error| AppError::Ai(format!("System 1 key task failed: {error}")))?
}

/// The model route [`system1_check`] should test. An explicitly supplied draft
/// model wins; a draft URL with a blank model follows **that host's** default,
/// never the model saved for a different endpoint; with no draft URL the saved
/// model applies.
fn check_model(
    configured_model: &str,
    draft_url: Option<&str>,
    draft_model: Option<&str>,
) -> String {
    match (non_blank(draft_model), draft_url) {
        (Some(model), _) => model.to_string(),
        (None, Some(url)) => resolve_model(None, url),
        (None, None) => configured_model.to_string(),
    }
}

/// Verifies an endpoint and key with the cheapest possible request, resolving
/// with the model version that answered. Unset arguments fall back to the
/// saved key and the configured endpoint, so Settings can test either a draft
/// or what is already stored.
#[tauri::command]
pub async fn system1_check(
    app: tauri::AppHandle,
    store: State<'_, System1KeyStore>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> AppResult<String> {
    let settings = global_settings(&app)?;
    let (configured_url, configured_model) = effective_settings(&settings);
    let draft_url = base_url.filter(|url| !url.trim().is_empty());
    let model = check_model(&configured_model, draft_url.as_deref(), model.as_deref());
    let base_url = draft_url.unwrap_or(configured_url);
    let api_key = api_key
        .filter(|key| !key.trim().is_empty())
        .or_else(|| store.file.read())
        .ok_or_else(|| AppError::InvalidInput("no System 1 API key".to_string()))?;
    let value = run_sidecar(
        "system1-check",
        endpoint(&base_url, &model, api_key.trim()).to_string(),
    )
    .await?;
    Ok(value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

/// Reads the global or project `automode.md` verbatim for the Settings editor.
/// A missing file reports `exists: false`; the editor then offers a template.
#[tauri::command]
pub async fn read_automode(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    let mut document = read_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.system1.auto_mode_file_name.as_str(),
    )
    .await?;
    if !document.exists {
        // `read_scoped` seeds missing files with an empty JSON object, which is
        // meaningless for a markdown file.
        document.contents = String::new();
    }
    Ok(document)
}

/// Writes the global or project `automode.md`. The project copy goes through
/// the owning host, so an SSH project's preferences live on that host.
#[tauri::command]
pub async fn write_automode(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
    contents: String,
) -> AppResult<()> {
    write_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.system1.auto_mode_file_name.as_str(),
        contents,
    )
    .await?;
    Ok(())
}

/// Reads one scope's `automode.md`, or `None` when it does not exist. A read
/// failure (say, an offline SSH host) becomes a warning, never an error: auto
/// mode still works on the other scope and the benchmarks.
async fn automode_source(
    app: &tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    scope: ConfigScope,
    project_id: Option<String>,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let label = match scope {
        ConfigScope::Global => "global",
        ConfigScope::Project => "project",
    };
    match read_scoped(
        app.clone(),
        db,
        hosts,
        scope,
        project_id,
        CONSTANTS.system1.auto_mode_file_name.as_str(),
    )
    .await
    {
        Ok(document) => document.exists.then_some(document.contents),
        Err(error) => {
            warnings.push(format!("could not read {label} automode.md: {error}"));
            None
        }
    }
}

/// Picks an agent, model, and reasoning effort for a launch with the
/// configured System 1 model.
#[tauri::command]
pub async fn system1_auto_select(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    store: State<'_, System1KeyStore>,
    input: AutoSelectInput,
) -> AppResult<AutoSelection> {
    let api_key = store.file.read().ok_or_else(|| {
        AppError::InvalidInput("add a System 1 API key in Settings to use Auto".to_string())
    })?;
    let (base_url, model) = effective_settings(&global_settings(&app)?);
    let mut warnings = Vec::new();
    let global = automode_source(&app, &db, &hosts, ConfigScope::Global, None, &mut warnings).await;
    let project = match input.project_id.clone() {
        Some(project_id) => {
            automode_source(
                &app,
                &db,
                &hosts,
                ConfigScope::Project,
                Some(project_id),
                &mut warnings,
            )
            .await
        }
        None => None,
    };

    let limits = &CONSTANTS.system1;
    let request = json!({
        "endpoint": endpoint(&base_url, &model, &api_key),
        "prompt": input.prompt,
        "context": input.context,
        "agents": input.agents,
        "automode": { "global": global, "project": project },
        "limits": {
            "promptChars": limits.prompt_char_limit,
            "preferencesChars": limits.preferences_char_limit,
            "timeoutMs": limits.request_timeout_ms,
        },
    });
    let value = run_sidecar("auto-select", request.to_string()).await?;
    let selection = value
        .get("selection")
        .cloned()
        .ok_or_else(|| AppError::Ai("auto-select returned no selection".to_string()))?;
    let mut selection: AutoSelection = serde_json::from_value(selection)?;
    selection.warnings.extend(warnings);
    Ok(selection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_when_block_missing_or_malformed() {
        let (url, model) = effective_settings(&settings_from_config("{}"));
        assert_eq!(url, CONSTANTS.system1.default_base_url);
        assert_eq!(model, CONSTANTS.system1.default_model);
        let (url, _) = effective_settings(&settings_from_config(r#"{"system1": {"baseUrl": 42}}"#));
        assert_eq!(url, CONSTANTS.system1.default_base_url);
        let (url, _) = effective_settings(&settings_from_config("not json"));
        assert_eq!(url, CONSTANTS.system1.default_base_url);
    }

    #[test]
    fn settings_use_configured_values_and_ignore_blanks() {
        let (url, model) = effective_settings(&settings_from_config(
            r#"{"system1": {"baseUrl": " https://jev.example ", "model": ""}}"#,
        ));
        assert_eq!(url, "https://jev.example");
        assert_eq!(model, CONSTANTS.system1.default_model);
    }

    #[test]
    fn model_defaults_follow_the_endpoint_host() {
        assert_eq!(
            resolve_model(None, "https://openrouter.ai/api/alpha/decisions"),
            "~typesafe/jev-latest"
        );
        assert_eq!(
            resolve_model(None, "https://api.openrouter.ai/v1"),
            "~typesafe/jev-latest"
        );
        assert_eq!(
            resolve_model(None, "https://notopenrouter.ai"),
            CONSTANTS.system1.default_model
        );
        assert_eq!(
            resolve_model(None, "not a url"),
            CONSTANTS.system1.default_model
        );
        assert_eq!(
            resolve_model(Some(" typesafe/jev-1.13 "), "https://openrouter.ai/api"),
            "typesafe/jev-1.13"
        );
    }

    #[test]
    fn check_model_uses_draft_host_default_not_saved_model() {
        // A blank draft model against a new host must not reuse the old model.
        assert_eq!(
            check_model(
                "jev-latest",
                Some("https://openrouter.ai/api/alpha/decisions"),
                None
            ),
            "~typesafe/jev-latest"
        );
        // An explicit draft model still wins.
        assert_eq!(
            check_model(
                "jev-latest",
                Some("https://openrouter.ai/api"),
                Some("typesafe/jev-1.13")
            ),
            "typesafe/jev-1.13"
        );
        // With no draft URL, the configured model applies.
        assert_eq!(check_model("jev-latest", None, None), "jev-latest");
    }

    #[test]
    fn selection_parses_sidecar_output() {
        let selection: AutoSelection = serde_json::from_value(json!({
            "agentId": "codex",
            "modelId": "gpt-6-astra",
            "reasoningId": null,
            "confidence": 0.8,
            "lowConfidence": false,
            "difficulty": 0.5,
            "agentProbabilities": { "codex": 0.8 },
            "modelProbabilities": {},
            "reason": "Codex",
            "warnings": [],
            "sources": { "modelBenchmarks": true, "harnessBenchmarks": false },
        }))
        .unwrap();
        assert_eq!(selection.agent_id, "codex");
        assert!(selection.reasoning_id.is_none());
    }

    #[test]
    fn input_accepts_camel_case_models() {
        let input: AutoSelectInput = serde_json::from_value(json!({
            "projectId": "p",
            "prompt": "fix it",
            "agents": [{
                "id": "claude-code",
                "name": "Claude Code",
                "models": [{ "id": "opus", "name": "Opus", "canonicalId": "claude-opus-5-5" }],
            }],
        }))
        .unwrap();
        assert_eq!(
            input.agents[0].models[0].canonical_id.as_deref(),
            Some("claude-opus-5-5")
        );
        assert!(input.agents[0].models[0].reasoning.is_empty());
    }
}
