use std::path::{Path, PathBuf};

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentConfig {
    id: Option<String>,
    name: String,
    icon: Option<String>,
    start: StartCommand,
}

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

/// Installs Pragma-bundled agent configurations into `~/.pragma/agents`.
pub fn ensure_bundled_installed(app_handle: &AppHandle) -> AppResult<()> {
    let source = bundled_agents_dir(app_handle)?;
    if !source.is_dir() {
        return Ok(());
    }
    let destination = app_handle.path().home_dir()?.join(".pragma/agents");
    std::fs::create_dir_all(&destination)?;
    copy_dir_contents(&source, &destination)
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
    })
}

fn bundled_agents_dir(app_handle: &AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        let staged = workspace_root().join("apps/pragma/src-tauri/resources/pragma/agents");
        if staged.is_dir() {
            return Ok(staged);
        }
        return Ok(workspace_root().join("packages/opencode-plugin/pragma/agents"));
    }
    Ok(app_handle.path().resource_dir()?.join("pragma/agents"))
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
    use super::kebab_case;

    #[test]
    fn normalizes_agent_ids() {
        assert_eq!(kebab_case("Claude Code"), "claude-code");
        assert_eq!(kebab_case(" sample_agent!! "), "sample-agent");
    }
}
