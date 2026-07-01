use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::pty::workspace_root;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub icon_data_url: Option<String>,
    pub start: Vec<String>,
    pub startup_input: Vec<AgentStartupInput>,
    pub prefill_delay_ms: Option<u64>,
    pub prefill_mode: Option<String>,
    pub prefill_submit: Option<String>,
    pub prefill_submit_delay_ms: Option<u64>,
    pub models: Option<AgentModelsConfig>,
}

/// Optional timed input sent after an agent start command and before the prompt prefill.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartupInput {
    pub delay_ms: u64,
    pub data: String,
}

/// Optional model discovery/argument configuration from an agent launcher config.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum AgentModelsConfig {
    /// A config-owned static model list.
    #[serde(rename = "static", rename_all = "camelCase")]
    Static {
        model_arg: Option<Vec<String>>,
        reasoning_arg: Option<Vec<String>>,
        model_reasoning_arg: Option<Vec<String>>,
        items: Vec<RawAgentModel>,
    },
    /// A plugin-owned command that emits the generic JSON model list.
    #[serde(rename = "command", rename_all = "camelCase")]
    Command {
        command: Vec<String>,
        model_arg: Option<Vec<String>>,
        reasoning_arg: Option<Vec<String>>,
        model_reasoning_arg: Option<Vec<String>>,
    },
}

/// Model entry returned to the frontend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    pub id: String,
    pub name: String,
    pub reasoning: Vec<AgentReasoning>,
}

/// Optional reasoning effort exposed for a model.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReasoning {
    pub id: String,
    pub name: String,
}

/// Raw config/script model entry before validation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAgentModel {
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub reasoning: Vec<AgentReasoning>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentConfig {
    id: Option<String>,
    name: String,
    icon: Option<String>,
    start: StartCommand,
    #[serde(default)]
    startup_input: Vec<AgentStartupInput>,
    prefill_delay_ms: Option<u64>,
    prefill_mode: Option<String>,
    prefill_submit: Option<String>,
    prefill_submit_delay_ms: Option<u64>,
    models: Option<AgentModelsConfig>,
}

const MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StartCommand {
    String(String),
    Array(Vec<String>),
}

/// Lists agent configurations from `~/.pragma/agents/*/config.json`.
#[tauri::command]
pub fn list_agents(app_handle: tauri::AppHandle) -> AppResult<Vec<AgentConfig>> {
    let agents_dir = app_handle.path().home_dir()?.join(".pragma/agents");
    if !agents_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut agents = Vec::new();
    for entry in std::fs::read_dir(agents_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let config_path = dir.join("config.json");
        if !config_path.is_file() {
            continue;
        }
        agents.push(load_agent(&dir, &config_path)?);
    }
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(agents)
}

/// Resolves an agent's model list without blocking `list_agents` on model commands.
#[tauri::command]
pub fn resolve_agent_models(
    app_handle: tauri::AppHandle,
    agent_id: String,
) -> AppResult<Vec<AgentModel>> {
    let agents_dir = app_handle.path().home_dir()?.join(".pragma/agents");
    Ok(resolve_agent_models_from_dir(
        &agents_dir,
        &agent_id,
        MODEL_DISCOVERY_TIMEOUT,
    ))
}

/// Installs Pragma-bundled agent configurations into `~/.pragma/agents`.
pub fn ensure_bundled_installed(app_handle: &AppHandle) -> AppResult<()> {
    let destination = app_handle.path().home_dir()?.join(".pragma/agents");
    std::fs::create_dir_all(&destination)?;
    for source in bundled_agent_dirs(app_handle)? {
        if source.is_dir() {
            copy_dir_contents(&source, &destination)?;
        }
    }
    Ok(())
}

fn load_agent(dir: &Path, config_path: &Path) -> AppResult<AgentConfig> {
    let raw: RawAgentConfig = serde_json::from_str(&std::fs::read_to_string(config_path)?)?;
    let fallback_id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(raw.name.as_str());
    let id = kebab_case(raw.id.as_deref().unwrap_or(fallback_id));
    if id.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "agent config {} has an empty id",
            config_path.display()
        )));
    }
    let start = match raw.start {
        StartCommand::String(command) => vec![command],
        StartCommand::Array(command) => command,
    };
    if start.is_empty() || start.iter().any(|part| part.trim().is_empty()) {
        return Err(AppError::InvalidInput(format!(
            "agent config {} has an empty start command",
            config_path.display()
        )));
    }
    Ok(AgentConfig {
        id,
        name: raw.name,
        icon_data_url: raw
            .icon
            .as_deref()
            .map(|icon| icon_data_url(dir, icon))
            .transpose()?,
        start,
        startup_input: raw.startup_input,
        prefill_delay_ms: raw.prefill_delay_ms,
        prefill_mode: raw.prefill_mode,
        prefill_submit: raw.prefill_submit,
        prefill_submit_delay_ms: raw.prefill_submit_delay_ms,
        models: raw.models,
    })
}

fn resolve_agent_models_from_dir(
    agents_dir: &Path,
    agent_id: &str,
    timeout: Duration,
) -> Vec<AgentModel> {
    let Ok(entries) = std::fs::read_dir(agents_dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let dir = entry.path();
        let config_path = dir.join("config.json");
        if !config_path.is_file() {
            continue;
        }
        let Ok(agent) = load_agent(&dir, &config_path) else {
            continue;
        };
        if agent.id != agent_id {
            continue;
        }
        return resolve_models_for_agent_dir(&dir, agent.models.as_ref(), timeout);
    }
    Vec::new()
}

fn resolve_models_for_agent_dir(
    agent_dir: &Path,
    models: Option<&AgentModelsConfig>,
    timeout: Duration,
) -> Vec<AgentModel> {
    let Some(models) = models else {
        return Vec::new();
    };
    match models {
        AgentModelsConfig::Static { items, .. } => validate_models(items.clone()),
        AgentModelsConfig::Command { command, .. } => command_models(agent_dir, command, timeout),
    }
}

fn command_models(agent_dir: &Path, command: &[String], timeout: Duration) -> Vec<AgentModel> {
    if command.is_empty() || command.iter().any(|part| part.trim().is_empty()) {
        return Vec::new();
    }
    let Some(output) = command_output(agent_dir, command, timeout) else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_slice::<Vec<RawAgentModel>>(&output) else {
        return Vec::new();
    };
    validate_models(items)
}

fn command_output(agent_dir: &Path, command: &[String], timeout: Duration) -> Option<Vec<u8>> {
    let mut child = crate::process_env::command(&command[0])
        .args(&command[1..])
        .current_dir(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok()?;
                return status.success().then_some(output.stdout);
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

fn validate_models(items: Vec<RawAgentModel>) -> Vec<AgentModel> {
    items
        .into_iter()
        .filter_map(|item| {
            let id = item.id.as_deref().unwrap_or_default().trim();
            let name = item.name.as_deref().unwrap_or_default().trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let reasoning = item
                .reasoning
                .into_iter()
                .filter_map(|entry| {
                    let id = entry.id.trim();
                    let name = entry.name.trim();
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(AgentReasoning {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                })
                .collect();
            Some(AgentModel {
                id: id.to_string(),
                name: name.to_string(),
                reasoning,
            })
        })
        .collect()
}

fn bundled_agent_dirs(app_handle: &AppHandle) -> AppResult<Vec<PathBuf>> {
    if cfg!(debug_assertions) {
        let staged = workspace_root().join("apps/pragma/src-tauri/resources/pragma/agents");
        if staged.is_dir() {
            return Ok(vec![staged]);
        }
        let root = workspace_root();
        return Ok(vec![
            root.join("packages/opencode-plugin/pragma/agents"),
            root.join("packages/claude-code-plugin/pragma/agents"),
            root.join("packages/cursor-plugin/pragma/agents"),
        ]);
    }
    Ok(vec![app_handle
        .path()
        .resource_dir()?
        .join("pragma/agents")])
}

fn copy_dir_contents(source: &Path, destination: &Path) -> AppResult<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            std::fs::create_dir_all(&destination_path)?;
            copy_dir_contents(&source_path, &destination_path)?;
        } else {
            copy_if_changed(&source_path, &destination_path)?;
        }
    }
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

fn icon_data_url(agent_dir: &Path, icon: &str) -> AppResult<String> {
    let base = agent_dir.canonicalize()?;
    let path = agent_dir.join(icon);
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&base) {
        return Err(AppError::InvalidInput(
            "agent icon escapes its directory".to_string(),
        ));
    }
    let mime = mime_for(&canonical);
    let data = base64::engine::general_purpose::STANDARD.encode(std::fs::read(canonical)?);
    Ok(format!("data:{mime};base64,{data}"))
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("svg") => "image/svg+xml",
        Some(extension) if extension.eq_ignore_ascii_case("ico") => "image/x-icon",
        _ => "image/png",
    }
}

fn kebab_case(value: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash && !out.is_empty() {
            out.push('-');
            previous_dash = true;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use super::{
        command_models, kebab_case, load_agent, resolve_agent_models_from_dir, AgentModelsConfig,
    };

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Restores an environment variable to its original value (or removes it) on drop.
    struct EnvGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn write_agent(root: &std::path::Path, id: &str, config: &str) -> std::path::PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), config).unwrap();
        dir
    }

    #[test]
    fn normalizes_agent_ids() {
        assert_eq!(kebab_case("Claude Code"), "claude-code");
        assert_eq!(kebab_case(" sample_agent!! "), "sample-agent");
    }

    #[test]
    fn parses_optional_static_model_config() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_agent(
            temp.path(),
            "claude-code",
            r#"{
              "id": "claude-code",
              "name": "Claude Code",
              "start": ["claude"],
              "models": {
                "source": "static",
                "modelArg": ["--model", "{model}"],
                "reasoningArg": ["--effort", "{reasoning}"],
                "items": [{"id": "sonnet", "name": "Sonnet"}]
              }
            }"#,
        );

        let agent = load_agent(&dir, &dir.join("config.json")).unwrap();
        match agent.models.unwrap() {
            AgentModelsConfig::Static {
                model_arg,
                reasoning_arg,
                model_reasoning_arg,
                items,
            } => {
                assert_eq!(model_arg.unwrap(), ["--model", "{model}"]);
                assert_eq!(reasoning_arg.unwrap(), ["--effort", "{reasoning}"]);
                assert!(model_reasoning_arg.is_none());
                assert_eq!(items[0].id.as_deref(), Some("sonnet"));
            }
            AgentModelsConfig::Command { .. } => panic!("expected static models"),
        }
    }

    #[test]
    fn preserves_current_behavior_without_models() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_agent(
            temp.path(),
            "plain",
            r#"{"name":"Plain","start":["plain"]}"#,
        );

        let agent = load_agent(&dir, &dir.join("config.json")).unwrap();
        assert_eq!(agent.id, "plain");
        assert!(agent.models.is_none());
        assert_eq!(
            resolve_agent_models_from_dir(temp.path(), "plain", Duration::from_secs(1)),
            Vec::new()
        );
    }

    #[test]
    fn parses_optional_launch_timing_config() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_agent(
            temp.path(),
            "gated",
            r#"{
              "id": "gated",
              "name": "Gated Agent",
              "start": ["agent"],
              "startupInput": [{"delayMs": 1000, "data": "a\r"}],
              "prefillDelayMs": 7000,
              "prefillMode": "plain",
              "prefillSubmitDelayMs": 120,
              "prefillSubmit": "\u001b[13;5u"
            }"#,
        );

        let agent = load_agent(&dir, &dir.join("config.json")).unwrap();
        assert_eq!(agent.startup_input.len(), 1);
        assert_eq!(agent.startup_input[0].delay_ms, 1000);
        assert_eq!(agent.startup_input[0].data, "a\r");
        assert_eq!(agent.prefill_delay_ms, Some(7000));
        assert_eq!(agent.prefill_mode.as_deref(), Some("plain"));
        assert_eq!(agent.prefill_submit.as_deref(), Some("\u{1b}[13;5u"));
        assert_eq!(agent.prefill_submit_delay_ms, Some(120));
    }

    #[test]
    fn resolves_static_models_and_ignores_invalid_entries() {
        let temp = tempfile::tempdir().unwrap();
        write_agent(
            temp.path(),
            "test",
            r#"{
              "id": "test",
              "name": "Test",
              "start": ["test"],
              "models": {
                "source": "static",
                "items": [
                  {"id": "", "name": "Broken"},
                  {"id": "gpt-5.5", "name": "GPT-5.5", "reasoning": [
                    {"id": "low", "name": "Low"},
                    {"id": "", "name": "Broken"}
                  ]}
                ]
              }
            }"#,
        );

        let models = resolve_agent_models_from_dir(temp.path(), "test", Duration::from_secs(1));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.5");
        assert_eq!(models[0].reasoning.len(), 1);
    }

    #[test]
    fn resolves_command_models_with_agent_dir_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_agent(
            temp.path(),
            "cursor",
            r#"{
              "id": "cursor",
              "name": "Cursor",
              "start": ["agent"],
              "models": {"source": "command", "command": ["sh", "scripts/list-models.sh"]}
            }"#,
        );
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("marker"), "").unwrap();
        std::fs::write(
            dir.join("scripts/list-models.sh"),
            "[ -f marker ] || exit 1\nprintf '[{\"id\":\"model\",\"name\":\"Model\"}]'\n",
        )
        .unwrap();

        let models = resolve_agent_models_from_dir(temp.path(), "cursor", Duration::from_secs(1));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "model");
    }

    #[test]
    fn command_models_uses_gui_safe_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _home = EnvGuard {
            key: "HOME",
            original: std::env::var_os("HOME"),
        };
        let _path = EnvGuard {
            key: "PATH",
            original: std::env::var_os("PATH"),
        };
        let temp = tempfile::tempdir().unwrap();
        let home_bin = temp.path().join(".opencode/bin");
        std::fs::create_dir_all(&home_bin).unwrap();
        let helper = home_bin.join("test-models");
        std::fs::write(
            &helper,
            "#!/bin/sh\nprintf '[{\"id\":\"model\",\"name\":\"Model\"}]'\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
        }
        std::fs::set_permissions(&helper, permissions).unwrap();
        let agent_dir = temp.path().join("agent");
        std::fs::create_dir_all(agent_dir.join("scripts")).unwrap();
        std::fs::write(agent_dir.join("scripts/list-models.sh"), "test-models\n").unwrap();

        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let models = command_models(
            &agent_dir,
            &["sh".to_string(), "scripts/list-models.sh".to_string()],
            Duration::from_secs(1),
        );

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "model");
    }

    #[test]
    fn command_invalid_json_returns_empty_list() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_agent(
            temp.path(),
            "cursor",
            r#"{
              "id": "cursor",
              "name": "Cursor",
              "start": ["agent"],
              "models": {"source": "command", "command": ["sh", "scripts/list-models.sh"]}
            }"#,
        );
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("scripts/list-models.sh"), "printf 'not json'\n").unwrap();

        assert_eq!(
            resolve_agent_models_from_dir(temp.path(), "cursor", Duration::from_secs(1)),
            Vec::new()
        );
    }

    #[test]
    fn command_failure_returns_empty_list() {
        let temp = tempfile::tempdir().unwrap();
        write_agent(
            temp.path(),
            "cursor",
            r#"{
              "id": "cursor",
              "name": "Cursor",
              "start": ["agent"],
              "models": {"source": "command", "command": ["sh", "-c", "exit 7"]}
            }"#,
        );

        assert_eq!(
            resolve_agent_models_from_dir(temp.path(), "cursor", Duration::from_secs(1)),
            Vec::new()
        );
    }

    #[test]
    fn command_timeout_returns_empty_list() {
        let temp = tempfile::tempdir().unwrap();
        write_agent(
            temp.path(),
            "cursor",
            r#"{
              "id": "cursor",
              "name": "Cursor",
              "start": ["agent"],
              "models": {"source": "command", "command": ["sh", "-c", "sleep 2"]}
            }"#,
        );

        let started = Instant::now();
        assert_eq!(
            resolve_agent_models_from_dir(temp.path(), "cursor", Duration::from_millis(50)),
            Vec::new(),
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
