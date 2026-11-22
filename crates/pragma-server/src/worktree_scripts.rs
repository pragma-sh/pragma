//! Worktree lifecycle scripts as this host runs them.
//!
//! The desktop runs `setup`/`teardown` for the worktrees it creates and
//! deletes; this module does the same for the ones the server handles on its
//! own — fanout attempts and worktrees a phone creates — so a checkout is
//! equivalent whichever side made it. Both read the same two layers through
//! `pragma_core::scripts`: the project's `.pragma/scripts.json` and this
//! host's global `~/.pragma/config.json`.

use std::path::Path;

use pragma_constants::CONSTANTS;
use pragma_core::exec::{CommandResult, ExecRequest};
use pragma_core::scripts::{GlobalScripts, ProjectScripts, ScriptEvent, ScriptPhase};

/// Reads and validates a project's `.pragma/scripts.json`.
///
/// A missing file is an empty config, not an error: most projects have no
/// scripts. A file that exists but does not parse *is* an error, because the
/// user wrote something and it is not doing what they meant.
pub(crate) fn read_project_scripts(root: &str) -> Result<ProjectScripts, String> {
    let path = Path::new(root).join(CONSTANTS.scripts.config_path.as_str());
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectScripts::default())
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    pragma_core::scripts::parse_config(&raw, &path).map_err(|error| error.to_string())
}

/// This host's global scripts. `home` is `None` only where there is no home
/// directory to read (and in tests, which must not read the developer's).
pub(crate) fn read_global_scripts(home: Option<&Path>) -> Result<GlobalScripts, String> {
    home.map_or_else(
        || Ok(GlobalScripts::default()),
        |home| pragma_core::scripts::read_global_scripts(home).map_err(|error| error.to_string()),
    )
}

/// The project's scripts with this host's global run scripts layered under
/// them: what a worktree's header (or a phone's script list) offers.
pub(crate) fn effective_scripts(home: Option<&Path>, root: &str) -> Result<ProjectScripts, String> {
    let project = read_project_scripts(root)?;
    Ok(project.with_global_run_scripts(&read_global_scripts(home)?))
}

/// Runs global then project `setup` in a freshly created checkout.
pub(crate) fn run_setup(
    home: Option<&Path>,
    project_root: &str,
    worktree_root: &str,
    worktree_id: &str,
) -> Result<(), String> {
    let project = read_project_scripts(project_root)?;
    let global = read_global_scripts(home)?;
    run_phases(
        &global.setup_phases(&project),
        "setup",
        ScriptEvent::WorktreeSetup,
        project_root,
        worktree_root,
        worktree_id,
    )
}

/// Runs project then global `teardown` in a checkout about to be removed.
pub(crate) fn run_teardown(
    home: Option<&Path>,
    project_root: &str,
    worktree_root: &str,
    worktree_id: &str,
) -> Result<(), String> {
    let project = read_project_scripts(project_root)?;
    let global = read_global_scripts(home)?;
    run_phases(
        &global.teardown_phases(&project),
        "teardown",
        ScriptEvent::WorktreeTeardown,
        project_root,
        worktree_root,
        worktree_id,
    )
}

/// Runs each phase to completion before the next, stopping at the first one
/// with a failed command.
fn run_phases(
    phases: &[ScriptPhase<'_>],
    hook: &str,
    event: ScriptEvent,
    project_root: &str,
    worktree_root: &str,
    worktree_id: &str,
) -> Result<(), String> {
    let mut env = pragma_core::scripts::worktree_env(project_root, worktree_root, worktree_id);
    env.push(event.env());
    for phase in phases.iter().filter(|phase| !phase.commands.is_empty()) {
        let results = run_exec(&ExecRequest {
            cwd: worktree_root.to_string(),
            commands: phase.commands.to_vec(),
            env: env.clone(),
            max_concurrent: u32::try_from(CONSTANTS.scripts.max_concurrent_commands.get())
                .unwrap_or(1),
            run_id: None,
        })?;
        let failures: Vec<&CommandResult> = results
            .iter()
            .filter(|result| result.status != Some(0))
            .collect();
        if !failures.is_empty() {
            return Err(format!(
                "{} scripts failed: {}",
                phase.label(hook),
                describe_failures(&failures)
            ));
        }
    }
    Ok(())
}

/// Runs an `exec` batch in-process through the same handler the RPC uses, so
/// a cancel arriving over the socket finds its run registered.
pub(crate) fn run_exec(request: &ExecRequest) -> Result<Vec<CommandResult>, String> {
    let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
    let value = pragma_core::exec::handle(payload).map_err(|error| error.to_string())?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn describe_failures(failures: &[&CommandResult]) -> String {
    failures
        .iter()
        .map(|result| {
            format!(
                "`{}` exited {}: {}",
                result.command,
                result
                    .status
                    .map_or_else(|| "by signal".to_string(), |code| code.to_string()),
                result.stderr.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::tempdir;

    use super::{effective_scripts, run_setup, run_teardown};

    fn write(root: &Path, relative: &str, body: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    #[cfg(unix)]
    #[test]
    fn setup_runs_the_global_phase_before_the_projects() {
        let home = tempdir().expect("home");
        let project = tempdir().expect("project");
        let worktree = tempdir().expect("worktree");
        write(
            home.path(),
            ".pragma/config.json",
            r#"{"scripts":{"worktree":{"setup":["echo \"global:$PRAGMA_SCRIPT_EVENT\" >> order.txt"]}}}"#,
        );
        write(
            project.path(),
            ".pragma/scripts.json",
            r#"{"setup":["echo project >> order.txt"]}"#,
        );

        run_setup(
            Some(home.path()),
            &project.path().to_string_lossy(),
            &worktree.path().to_string_lossy(),
            "wt-1",
        )
        .expect("setup succeeds");

        let order = std::fs::read_to_string(worktree.path().join("order.txt")).expect("order");
        assert_eq!(order, "global:worktree.setup\nproject\n");
    }

    #[test]
    fn a_failed_global_teardown_names_its_layer() {
        let home = tempdir().expect("home");
        let project = tempdir().expect("project");
        let worktree = tempdir().expect("worktree");
        write(
            home.path(),
            ".pragma/config.json",
            r#"{"scripts":{"worktree":{"teardown":["exit 3"]}}}"#,
        );

        let error = run_teardown(
            Some(home.path()),
            &project.path().to_string_lossy(),
            &worktree.path().to_string_lossy(),
            "wt-1",
        )
        .expect_err("a failing teardown fails");

        assert!(
            error.starts_with("global teardown scripts failed"),
            "{error}"
        );
    }

    #[test]
    fn a_malformed_project_file_fails_setup_instead_of_skipping_it() {
        let project = tempdir().expect("project");
        let worktree = tempdir().expect("worktree");
        write(project.path(), ".pragma/scripts.json", "{ not json");

        // An attempt set up without its dependencies fails later for a reason
        // nobody can see; the typo is the thing to report.
        let error = run_setup(
            None,
            &project.path().to_string_lossy(),
            &worktree.path().to_string_lossy(),
            "wt-1",
        )
        .expect_err("a broken config is reported");

        assert!(error.contains("not valid JSON"), "{error}");
    }

    #[test]
    fn global_run_scripts_appear_beside_the_projects() {
        let home = tempdir().expect("home");
        let project = tempdir().expect("project");
        write(
            home.path(),
            ".pragma/config.json",
            r#"{"scripts":{"worktree":{"runScripts":{"git":{"command":["lazygit"]}}}}}"#,
        );
        write(
            project.path(),
            ".pragma/scripts.json",
            r#"{"runScripts":{"dev":{"command":["bun dev"]}}}"#,
        );

        let scripts =
            effective_scripts(Some(home.path()), &project.path().to_string_lossy()).expect("valid");

        let names: Vec<&str> = scripts.run_scripts.keys().map(String::as_str).collect();
        assert_eq!(names, ["dev", "git"]);
    }
}
