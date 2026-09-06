//! Importing another orchestrator's checked-in lifecycle scripts into
//! `.pragma/scripts.json`.
//!
//! A repository that was previously driven by Superset, Emdash, or Orca already
//! carries the commands Pragma wants: how to prepare a fresh worktree, how to
//! start the dev server, how to tear it down. On project open the frontend asks
//! [`detect_script_migration`] whether such a file exists, and offers a one-click
//! import (optionally committed) rather than making the user retype them.
//!
//! Everything below the IPC layer is pure: a foreign config's text goes in, an
//! [`ImportedScripts`] comes out, and [`scripts_json`] renders the Pragma file.
//! The tool-specific parsers live here — this is translation of a foreign
//! format, not part of Pragma's own script contract in [`crate::scripts`].

use std::path::Path;

use pragma_constants::{FileContents, ScriptMigrationSource, CONSTANTS};
use pragma_core::fs::FsRequest;
use pragma_core::git::GitRequest;
use serde_json::{json, Value};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::git::host_rpc;
use crate::hosts::Hosts;
use crate::pty::PtyClient;

/// DB settings key prefix for "don't offer this project's import again".
const DISMISSED_KEY_PREFIX: &str = "script_migration_dismissed:";

/// Lifecycle commands lifted out of another tool's config, in Pragma's own
/// vocabulary. `run` becomes the `run` entry of `runScripts`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportedScripts {
    pub setup: Vec<String>,
    pub run: Vec<String>,
    pub teardown: Vec<String>,
}

impl ImportedScripts {
    /// True when there is nothing worth importing, in which case no prompt is
    /// shown: an empty `.pragma/scripts.json` helps nobody.
    fn is_empty(&self) -> bool {
        self.setup.is_empty() && self.run.is_empty() && self.teardown.is_empty()
    }
}

/// A detected import offer, sent to the frontend prompt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptMigrationOffer {
    /// Stable id of the source tool (`superset`, `emdash`, `orca`).
    pub source_id: String,
    /// Display name of the source tool.
    pub source_label: String,
    /// Project-root-relative path the commands were read from.
    pub config_path: String,
    pub setup: Vec<String>,
    pub run: Vec<String>,
    pub teardown: Vec<String>,
    /// Exact `.pragma/scripts.json` body the import would write, so the prompt
    /// can preview what lands in the repository.
    pub preview: String,
}

/// Detects an importable foreign script config for a project.
///
/// Returns `None` when the project already has `.pragma/scripts.json`, when the
/// user dismissed the offer for this project, or when no supported config holds
/// any command. Sources are probed in `scripts.migrationSources` order, so a
/// project carrying several configs is offered exactly one.
#[tauri::command(async)]
pub fn detect_script_migration(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
) -> AppResult<Option<ScriptMigrationOffer>> {
    if dismissed(&db, &project_id)? {
        return Ok(None);
    }
    let project = db.project(&project_id)?;
    let pty = hosts.for_project(&db, &project_id)?;
    detect_on_host(&pty, &project.path)
}

/// Writes the detected import to `.pragma/scripts.json` on the project's host,
/// optionally committing it. Re-detects first, so a config that changed (or a
/// `.pragma/scripts.json` that appeared) since the prompt opened is honored.
#[tauri::command(async)]
pub fn apply_script_migration(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
    commit: bool,
) -> AppResult<()> {
    let project = db.project(&project_id)?;
    let pty = hosts.for_project(&db, &project_id)?;
    let offer = detect_on_host(&pty, &project.path)?.ok_or_else(|| {
        AppError::InvalidInput("no importable script config was found for this project".to_string())
    })?;
    write_scripts_config(&pty, &project.path, &offer.preview)?;
    if commit {
        commit_scripts_config(&pty, &project.path)?;
    }
    dismiss(&db, &project_id)?;
    Ok(())
}

/// Records that a project's import offer should not be shown again. Applying an
/// import dismisses it too — the written file would suppress it anyway, but the
/// flag keeps the prompt quiet if the file is later deleted.
#[tauri::command(async)]
pub fn dismiss_script_migration(db: State<'_, Db>, project_id: String) -> AppResult<()> {
    dismiss(&db, &project_id)
}

fn dismissed(db: &Db, project_id: &str) -> AppResult<bool> {
    Ok(db
        .setting(&format!("{DISMISSED_KEY_PREFIX}{project_id}"))?
        .as_deref()
        == Some("true"))
}

fn dismiss(db: &Db, project_id: &str) -> AppResult<()> {
    db.set_setting(&format!("{DISMISSED_KEY_PREFIX}{project_id}"), "true")
}

/// Probes every configured source on `pty`'s host and builds the first offer
/// that yields commands.
///
/// Checks for an existing `.pragma/scripts.json` with `PathExists` rather than
/// `read_text`'s best-effort read: a read failure there (permission denied, a
/// transient host error) must not be mistaken for "no file", or a migration
/// gets offered — and later applied — over a config the read merely couldn't
/// see. Errors here propagate instead of being swallowed.
fn detect_on_host(pty: &PtyClient, project_root: &str) -> AppResult<Option<ScriptMigrationOffer>> {
    let target_exists: bool = fs_rpc(
        pty,
        &FsRequest::PathExists {
            root: project_root.to_string(),
            path: CONSTANTS.scripts.config_path.to_string(),
        },
    )?;
    if target_exists {
        return Ok(None);
    }
    for source in &CONSTANTS.scripts.migration_sources {
        for config_path in &source.config_paths {
            let Some(raw) = read_text(pty, project_root, config_path.as_str()) else {
                continue;
            };
            let Some(imported) = parse_source(source, config_path.as_str(), &raw) else {
                continue;
            };
            if imported.is_empty() {
                continue;
            }
            return Ok(Some(offer(source, config_path.as_str(), &imported)));
        }
    }
    Ok(None)
}

fn offer(
    source: &ScriptMigrationSource,
    config_path: &str,
    imported: &ImportedScripts,
) -> ScriptMigrationOffer {
    ScriptMigrationOffer {
        source_id: source.id.to_string(),
        source_label: source.label.to_string(),
        config_path: config_path.to_string(),
        setup: imported.setup.clone(),
        run: imported.run.clone(),
        teardown: imported.teardown.clone(),
        preview: scripts_json(imported),
    }
}

/// Reads a project-root-relative file through the host's `filesystem` RPC,
/// returning `None` when it is absent, binary, or truncated.
fn read_text(pty: &PtyClient, project_root: &str, path: &str) -> Option<String> {
    let contents: FileContents = fs_rpc(
        pty,
        &FsRequest::ReadFile {
            root: project_root.to_string(),
            path: path.to_string(),
        },
    )
    .ok()?;
    if contents.binary || contents.truncated {
        return None;
    }
    Some(contents.text)
}

/// Writes `.pragma/scripts.json`, creating the `.pragma` directory when the
/// project does not have one yet.
fn write_scripts_config(pty: &PtyClient, project_root: &str, body: &str) -> AppResult<()> {
    let config_path = CONSTANTS.scripts.config_path.as_str();
    if let Some((directory, _)) = config_path.rsplit_once('/') {
        let exists: bool = fs_rpc(
            pty,
            &FsRequest::PathExists {
                root: project_root.to_string(),
                path: directory.to_string(),
            },
        )?;
        if !exists {
            fs_rpc::<()>(
                pty,
                &FsRequest::CreateFolder {
                    root: project_root.to_string(),
                    path: directory.to_string(),
                },
            )?;
        }
    }
    fs_rpc::<()>(
        pty,
        &FsRequest::WriteFile {
            root: project_root.to_string(),
            path: config_path.to_string(),
            contents: body.to_string(),
        },
    )
}

/// Stages and commits the generated config on the project's host.
///
/// Commits with `CommitPath` rather than `CommitStaged`: the dialog promises
/// this commits only the imported config, but `CommitStaged` records the
/// whole index, so any other work the user already had staged would ride
/// along under the generated-config message. Scoping the commit to this one
/// path leaves the rest of the index exactly as it was.
fn commit_scripts_config(pty: &PtyClient, project_root: &str) -> AppResult<()> {
    host_rpc::<()>(
        pty,
        &GitRequest::StageFile {
            root: project_root.to_string(),
            path: CONSTANTS.scripts.config_path.to_string(),
        },
    )?;
    host_rpc::<()>(
        pty,
        &GitRequest::CommitPath {
            root: project_root.to_string(),
            path: CONSTANTS.scripts.config_path.to_string(),
            message: commit_message(),
        },
    )
}

/// Conventional-commit subject for the generated config. No trailers: the
/// committing user is the sole author of the file Pragma wrote for them.
fn commit_message() -> String {
    CONSTANTS.scripts.migration_commit_message.to_string()
}

/// Serializable `.pragma/scripts.json` shape. A struct rather than a JSON map so
/// the written file keeps lifecycle order (setup, run, teardown) instead of the
/// alphabetical order `serde_json::Map` imposes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedScriptsConfig<'a> {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    setup: &'a Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_scripts: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    teardown: &'a Vec<String>,
}

/// Renders imported commands as a `.pragma/scripts.json` body. Empty sections
/// are omitted so the written file only states what the project actually has.
fn scripts_json(imported: &ImportedScripts) -> String {
    let config = GeneratedScriptsConfig {
        setup: &imported.setup,
        run_scripts: (!imported.run.is_empty())
            .then(|| json!({ "run": { "command": imported.run } })),
        teardown: &imported.teardown,
    };
    let mut body = serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string());
    body.push('\n');
    body
}

/// Parses one source's config text. `config_path` disambiguates Orca, which has
/// both a YAML and a JSON form.
fn parse_source(
    source: &ScriptMigrationSource,
    config_path: &str,
    raw: &str,
) -> Option<ImportedScripts> {
    match source.id.as_str() {
        "superset" => Some(rewrite_env(parse_command_list_json(raw)?, SUPERSET_ENV)),
        "emdash" => Some(parse_emdash(raw)?),
        "orca" if has_json_extension(config_path) => Some(parse_command_list_json(raw)?),
        "orca" => Some(parse_orca_yaml(raw)),
        _ => None,
    }
}

/// Whether a config path is Orca's JSON form rather than its YAML one.
fn has_json_extension(config_path: &str) -> bool {
    Path::new(config_path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
}

/// Superset's environment variables, mapped onto the ones Pragma exports to
/// lifecycle scripts. An imported command keeps working instead of expanding to
/// an empty string.
const SUPERSET_ENV: &[(&str, &str)] = &[
    ("SUPERSET_ROOT_PATH", "PRAGMA_PROJECT_PATH"),
    ("SUPERSET_WORKSPACE_PATH", "PRAGMA_WORKTREE_PATH"),
    ("SUPERSET_WORKSPACE_NAME", "PRAGMA_WORKTREE_ID"),
];

/// `.superset/config.json` (and Orca's JSON form): `setup`/`run`/`teardown` as
/// string arrays — or a bare string — plus an optional `cwd` every command runs
/// in, which Pragma expresses by prefixing a `cd`.
fn parse_command_list_json(raw: &str) -> Option<ImportedScripts> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let cwd = object.get("cwd").and_then(Value::as_str);
    Some(ImportedScripts {
        setup: commands_at(object.get("setup"), cwd),
        run: commands_at(object.get("run"), cwd),
        teardown: commands_at(object.get("teardown"), cwd),
    })
}

/// `.emdash.json`: one command string per lifecycle key under `scripts`, with an
/// optional `shellSetup` that Emdash runs before each of them.
fn parse_emdash(raw: &str) -> Option<ImportedScripts> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let shell_setup = object.get("shellSetup").and_then(Value::as_str);
    let scripts = object.get("scripts").and_then(Value::as_object);
    let read = |key: &str| -> Vec<String> {
        scripts
            .and_then(|scripts| scripts.get(key))
            .map(commands)
            .unwrap_or_default()
            .into_iter()
            .map(|command| prefix_shell_setup(&command, shell_setup))
            .collect()
    };
    Some(ImportedScripts {
        setup: read("setup"),
        run: read("run"),
        teardown: read("teardown"),
    })
}

/// `orca.yaml`, read as a deliberately small subset: `setup`/`run`/`teardown`
/// keys — at the root or nested under any parent, since Orca groups them under
/// `worktree:`/`scripts:` — whose value is a scalar, an inline `[a, b]` list, or
/// a block list. Anything else in the document is ignored rather than rejected:
/// this is a best-effort import the user reviews before writing, not a YAML
/// parser Pragma has to keep correct.
fn parse_orca_yaml(raw: &str) -> ImportedScripts {
    let mut imported = ImportedScripts::default();
    let mut current: Option<&str> = None;
    for line in raw.lines() {
        let body = strip_yaml_comment(line).trim().to_string();
        if body.is_empty() {
            continue;
        }
        if let Some(item) = body.strip_prefix("- ") {
            if let Some(key) = current {
                push_yaml_command(&mut imported, key, unquote_yaml(item));
            }
            continue;
        }
        current = None;
        let Some((key, value)) = body.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if !matches!(key, "setup" | "run" | "teardown") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            current = Some(match key {
                "setup" => "setup",
                "run" => "run",
                _ => "teardown",
            });
            continue;
        }
        for command in yaml_inline_values(value) {
            push_yaml_command(&mut imported, key, command);
        }
    }
    imported
}

fn push_yaml_command(imported: &mut ImportedScripts, key: &str, command: String) {
    if command.is_empty() {
        return;
    }
    match key {
        "setup" => imported.setup.push(command),
        "run" => imported.run.push(command),
        "teardown" => imported.teardown.push(command),
        _ => {}
    }
}

/// Splits an inline YAML value into commands: `[a, b]` yields two, anything else
/// one. Quoted commands containing a comma are not split apart, because a
/// non-bracketed value is never treated as a list.
fn yaml_inline_values(value: &str) -> Vec<String> {
    let Some(inner) = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    else {
        return vec![unquote_yaml(value)];
    };
    inner
        .split(',')
        .map(unquote_yaml)
        .filter(|command| !command.is_empty())
        .collect()
}

/// Drops a trailing `#` comment. A `#` inside quotes is left alone, so a command
/// like `echo "a # b"` survives the import intact.
fn strip_yaml_comment(line: &str) -> String {
    let mut quote: Option<char> = None;
    for (index, character) in line.char_indices() {
        match (quote, character) {
            (Some(open), _) if character == open => quote = None,
            (None, '\'' | '"') => quote = Some(character),
            (None, '#') => return line[..index].to_string(),
            _ => {}
        }
    }
    line.to_string()
}

fn unquote_yaml(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|value| value.strip_suffix(quote))
        {
            return inner.to_string();
        }
    }
    value.to_string()
}

/// Reads a JSON lifecycle value as commands, applying an optional `cwd`.
fn commands_at(value: Option<&Value>, cwd: Option<&str>) -> Vec<String> {
    value
        .map(commands)
        .unwrap_or_default()
        .into_iter()
        .map(|command| prefix_cwd(&command, cwd))
        .collect()
}

/// Reads a JSON lifecycle value that may be a single command string or an array
/// of them. Non-string array entries are skipped.
fn commands(value: &Value) -> Vec<String> {
    match value {
        Value::String(command) => vec![command.trim().to_string()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|command| command.trim().to_string())
            .collect(),
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|command| !command.is_empty())
    .collect()
}

/// Prefixes `command` with a `cd` into `cwd`, quoted for the shell that will
/// run it (the same shell `pragma-core`'s exec RPC resolves at run time), so a
/// directory containing spaces or other shell-significant characters does not
/// split the `cd` into the wrong path or break the command apart.
fn prefix_cwd(command: &str, cwd: Option<&str>) -> String {
    match cwd {
        Some(cwd) if !cwd.trim().is_empty() && cwd != "." => {
            let shell = pragma_platform::shell::default_shell();
            let quoted = pragma_platform::shell::quote_for_shell(&shell, cwd);
            format!("cd {quoted} && {command}")
        }
        _ => command.to_string(),
    }
}

fn prefix_shell_setup(command: &str, shell_setup: Option<&str>) -> String {
    match shell_setup {
        Some(setup) if !setup.trim().is_empty() => format!("{} && {command}", setup.trim()),
        _ => command.to_string(),
    }
}

/// Rewrites `$VAR` / `${VAR}` references from a foreign tool's environment to
/// Pragma's equivalents.
fn rewrite_env(imported: ImportedScripts, mapping: &[(&str, &str)]) -> ImportedScripts {
    let rewrite = |command: String| -> String {
        mapping.iter().fold(command, |command, (from, to)| {
            command
                .replace(&format!("${{{from}}}"), &format!("${{{to}}}"))
                .replace(&format!("${from}"), &format!("${to}"))
        })
    };
    ImportedScripts {
        setup: imported.setup.into_iter().map(rewrite).collect(),
        run: imported.run.into_iter().map(rewrite).collect(),
        teardown: imported.teardown.into_iter().map(rewrite).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str) -> &'static ScriptMigrationSource {
        CONSTANTS
            .scripts
            .migration_sources
            .iter()
            .find(|source| source.id.as_str() == id)
            .expect("configured migration source")
    }

    fn parse(id: &str, path: &str, raw: &str) -> ImportedScripts {
        parse_source(source(id), path, raw).expect("parsed config")
    }

    #[test]
    fn imports_superset_commands_with_cwd_and_env() {
        let imported = parse(
            "superset",
            ".superset/config.json",
            r#"{
              "cwd": "apps/web",
              "setup": ["bun install", "cp \"$SUPERSET_ROOT_PATH/.env\" .env"],
              "run": ["bun dev"],
              "teardown": ["docker-compose down -v"]
            }"#,
        );
        assert_eq!(
            imported.setup,
            vec![
                "cd apps/web && bun install".to_string(),
                "cd apps/web && cp \"$PRAGMA_PROJECT_PATH/.env\" .env".to_string(),
            ]
        );
        assert_eq!(imported.run, vec!["cd apps/web && bun dev".to_string()]);
        assert_eq!(
            imported.teardown,
            vec!["cd apps/web && docker-compose down -v".to_string()]
        );
    }

    #[test]
    fn quotes_a_cwd_containing_a_space() {
        let imported = parse(
            "superset",
            ".superset/config.json",
            r#"{
              "cwd": "apps/web client",
              "setup": ["bun install"]
            }"#,
        );
        let shell = pragma_platform::shell::default_shell();
        let quoted = pragma_platform::shell::quote_for_shell(&shell, "apps/web client");
        assert_eq!(imported.setup, vec![format!("cd {quoted} && bun install")]);
        assert!(imported.setup[0].contains("apps/web client"));
    }

    #[test]
    fn imports_emdash_scripts_behind_shell_setup() {
        let imported = parse(
            "emdash",
            ".emdash.json",
            r#"{
              "preservePatterns": [".env"],
              "shellSetup": "source ~/.nvm/nvm.sh && nvm use",
              "scripts": {
                "setup": "pnpm install",
                "run": "pnpm dev",
                "teardown": "docker compose down"
              }
            }"#,
        );
        assert_eq!(
            imported.setup,
            vec!["source ~/.nvm/nvm.sh && nvm use && pnpm install".to_string()]
        );
        assert_eq!(
            imported.run,
            vec!["source ~/.nvm/nvm.sh && nvm use && pnpm dev".to_string()]
        );
        assert_eq!(
            imported.teardown,
            vec!["source ~/.nvm/nvm.sh && nvm use && docker compose down".to_string()]
        );
    }

    #[test]
    fn imports_orca_yaml_block_and_inline_lists() {
        let imported = parse(
            "orca",
            "orca.yaml",
            concat!(
                "worktree:\n",
                "  sharedDirectories:\n",
                "    - node_modules\n",
                "  setup:\n",
                "    - bun install    # deps\n",
                "    - \"echo 'a # b'\"\n",
                "  run: [bun dev, bun test --watch]\n",
                "teardown: docker compose down\n",
            ),
        );
        assert_eq!(
            imported.setup,
            vec!["bun install".to_string(), "echo 'a # b'".to_string()]
        );
        assert_eq!(
            imported.run,
            vec!["bun dev".to_string(), "bun test --watch".to_string()]
        );
        assert_eq!(imported.teardown, vec!["docker compose down".to_string()]);
    }

    #[test]
    fn orca_yaml_without_lifecycle_keys_imports_nothing() {
        let imported = parse(
            "orca",
            "orca.yaml",
            "worktree:\n  sharedDirectories:\n    - node_modules\n",
        );
        assert!(imported.is_empty());
    }

    #[test]
    fn renders_only_populated_sections() {
        let imported = ImportedScripts {
            setup: vec!["bun install".to_string()],
            run: vec!["bun dev".to_string()],
            teardown: Vec::new(),
        };
        assert_eq!(
            scripts_json(&imported),
            concat!(
                "{\n",
                "  \"setup\": [\n",
                "    \"bun install\"\n",
                "  ],\n",
                "  \"runScripts\": {\n",
                "    \"run\": {\n",
                "      \"command\": [\n",
                "        \"bun dev\"\n",
                "      ]\n",
                "    }\n",
                "  }\n",
                "}\n",
            )
        );
    }

    #[test]
    fn generated_config_is_valid_pragma_script_config() {
        let imported = ImportedScripts {
            setup: vec!["bun install".to_string()],
            run: vec!["bun dev".to_string()],
            teardown: vec!["docker compose down".to_string()],
        };
        let parsed = crate::scripts::parse_config(
            &scripts_json(&imported),
            std::path::Path::new("/p/.pragma/scripts.json"),
        )
        .expect("generated config parses");
        assert_eq!(parsed.setup, imported.setup);
        assert_eq!(parsed.teardown, imported.teardown);
        assert_eq!(
            parsed.run_scripts["run"].command,
            vec![Value::String("bun dev".to_string())]
        );
    }

    #[test]
    fn commit_message_is_the_conventional_subject() {
        assert_eq!(commit_message(), "chore(config): add pragma-app.sh config");
    }

    #[test]
    fn malformed_json_is_not_offered() {
        assert!(parse_source(source("superset"), ".superset/config.json", "{ not json").is_none());
    }
}
