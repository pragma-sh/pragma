//! The real [`FanoutHost`]: fanout orchestration wired to this host's git,
//! sessions, plugin catalog, and `pragma-ai` sidecar.
//!
//! Kept apart from `fanouts.rs` on purpose — that module holds the rules and is
//! tested against a fake host, while everything with a side effect lives here.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use pragma_constants::{FanoutDeliveryState, FanoutFailureCode, Worktree, CONSTANTS};
use pragma_core::exec::{CommandResult, ExecRequest};
use pragma_core::fanout::{CatalogAgentView, CatalogModelView};
use pragma_core::git::GitRequest;
use pragma_protocol::AgentInput;
use serde_json::Value;
use uuid::Uuid;

use crate::fanouts::{
    DeliveryTarget, FanoutHost, HostError, HostResult, LaunchSpec, ScratchpadCopy, WorktreeView,
};
use crate::registry::{AgentLaunch, FanoutMembership, Registry};

/// Maps a `pragma-core` error string onto a fanout failure code.
fn host_error(code: FanoutFailureCode, message: impl Into<String>) -> HostError {
    HostError::new(code, message)
}

/// Runs one `pragma-core` git request locally, the same operations the desktop
/// routes through host RPC.
fn git<T: for<'de> serde::Deserialize<'de>>(
    request: &GitRequest,
    code: FanoutFailureCode,
) -> HostResult<T> {
    let payload = serde_json::to_value(request)
        .map_err(|error| host_error(FanoutFailureCode::Internal, error.to_string()))?;
    let value = pragma_core::git::handle(payload).map_err(|error| {
        // A merge that stops on conflicts is a resumable state, not a bug; it
        // has to reach the caller as `mergeConflict` so finalization can park
        // instead of aborting.
        let message = error.to_string();
        let code = if message.contains("Merge conflicts detected") {
            FanoutFailureCode::MergeConflict
        } else {
            code
        };
        host_error(code, message)
    })?;
    serde_json::from_value(value)
        .map_err(|error| host_error(FanoutFailureCode::Internal, error.to_string()))
}

fn view(worktree: &Worktree) -> WorktreeView {
    WorktreeView {
        id: worktree.id.clone(),
        project_id: worktree.project_id.clone(),
        parent_id: worktree.parent_id.clone(),
        branch: worktree.branch.clone(),
        path: worktree.path.clone(),
    }
}

impl FanoutHost for Registry {
    fn project_root(&self, project_id: &str) -> HostResult<String> {
        Registry::project_root(self, project_id)
            .map_err(|error| host_error(FanoutFailureCode::NotFound, error))
    }

    fn worktree(&self, project_id: &str, worktree_id: &str) -> HostResult<WorktreeView> {
        self.mirrored_worktrees()
            .iter()
            .find(|worktree| worktree.id == worktree_id && worktree.project_id == project_id)
            .map(view)
            .ok_or_else(|| {
                host_error(
                    FanoutFailureCode::NotFound,
                    format!("worktree `{worktree_id}` is not in the mirrored workspace"),
                )
            })
    }

    fn find_worktree(&self, worktree_id: &str) -> Option<WorktreeView> {
        self.mirrored_worktrees()
            .iter()
            .find(|worktree| worktree.id == worktree_id)
            .map(view)
    }

    fn child_worktree_ids(&self, worktree_id: &str) -> Vec<String> {
        self.mirrored_worktrees()
            .iter()
            .filter(|worktree| worktree.parent_id.as_deref() == Some(worktree_id))
            .map(|worktree| worktree.id.clone())
            .collect()
    }

    /// The launchable agents of one project.
    ///
    /// Project-scoped plugins contributed by *another* root are filtered out:
    /// the catalog is a host-wide list, and offering another project's override
    /// here would launch the wrong command in this one.
    fn catalog(&self, project_root: &str) -> HostResult<Vec<CatalogAgentView>> {
        let catalog = self
            .project_catalog(project_root)
            .map_err(|error| host_error(FanoutFailureCode::Internal, error))?;
        let agents = catalog["agents"].as_array().cloned().unwrap_or_default();
        Ok(agents
            .iter()
            .filter(|agent| belongs_to_project(agent, project_root))
            .map(|agent| {
                let id = agent["id"].as_str().unwrap_or_default().to_string();
                CatalogAgentView {
                    runtime_agent_id: runtime_agent_id(agent, &id),
                    id,
                    models: agent["models"]
                        .as_array()
                        .map(|models| {
                            models
                                .iter()
                                .map(|model| CatalogModelView {
                                    id: model["id"].as_str().unwrap_or_default().to_string(),
                                    reasoning_ids: model["reasoning"]
                                        .as_array()
                                        .map(|levels| {
                                            levels
                                                .iter()
                                                .filter_map(|level| {
                                                    level["id"].as_str().map(str::to_string)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }
            })
            .collect())
    }

    fn head_commit(&self, root: &str) -> HostResult<String> {
        git(
            &GitRequest::HeadCommit {
                root: root.to_string(),
            },
            FanoutFailureCode::Internal,
        )
    }

    fn is_dirty(&self, root: &str) -> HostResult<bool> {
        git(
            &GitRequest::IsDirty {
                root: root.to_string(),
            },
            FanoutFailureCode::Internal,
        )
    }

    /// Creates a worktree at the captured commit and runs the project's setup
    /// scripts in it, so a server-created checkout is equivalent to one the
    /// desktop makes.
    fn create_worktree(
        &self,
        project_id: &str,
        parent_worktree_id: &str,
        branch: &str,
        commit: &str,
        title: Option<&str>,
    ) -> HostResult<WorktreeView> {
        let project_root = FanoutHost::project_root(self, project_id)?;
        let parent = FanoutHost::worktree(self, project_id, parent_worktree_id)?;
        let worktree_id = Uuid::new_v4().to_string();
        // Joined a segment at a time so the stored path uses the host's own
        // separator, matching the desktop's own creation path.
        let path = PathBuf::from(&project_root)
            .join(".pragma")
            .join("worktrees")
            .join(&worktree_id)
            .to_string_lossy()
            .into_owned();
        git::<Value>(
            &GitRequest::EnsurePragmaExcluded {
                project_root: project_root.clone(),
            },
            FanoutFailureCode::WorktreeCreateFailed,
        )?;
        git::<Value>(
            &GitRequest::CreateWorktreeAt {
                parent_root: parent.path,
                branch: branch.to_string(),
                path: path.clone(),
                commit: commit.to_string(),
            },
            FanoutFailureCode::WorktreeCreateFailed,
        )?;
        let worktree = Worktree {
            id: worktree_id.clone(),
            project_id: project_id.to_string(),
            parent_id: Some(parent_worktree_id.to_string()),
            branch: branch.to_string(),
            title: title
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string),
            path: path.clone(),
            is_main: false,
            hidden: false,
            created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        };
        self.insert_mirrored_worktree(worktree.clone())
            .map_err(|error| host_error(FanoutFailureCode::Internal, error))?;
        run_setup_scripts(&project_root, &path, &worktree_id)?;
        Ok(view(&worktree))
    }

    fn launch_agent(&self, spec: &LaunchSpec) -> HostResult<String> {
        self.launch_agent_session(&AgentLaunch {
            project_id: spec.project_id.clone(),
            worktree_id: spec.worktree_id.clone(),
            cwd: spec.cwd.clone(),
            agent_id: spec.catalog_agent_id.clone(),
            model_id: spec.model_id.clone(),
            reasoning_id: spec.reasoning_id.clone(),
            model_cmd: None,
            prompt: Some(spec.prompt.clone()),
            fanout: Some(FanoutMembership {
                fanout_id: spec.fanout_id.clone(),
                member_id: spec.member_id.clone(),
            }),
        })
        .map_err(|error| host_error(FanoutFailureCode::LaunchFailed, error))
    }

    fn read_tab(&self, tab_id: &str, lines: usize) -> HostResult<(Vec<u8>, String)> {
        self.session_output(tab_id, lines)
            .map_err(|error| host_error(FanoutFailureCode::NotFound, error))
    }

    /// Hands one follow-up to the watcher that owns this exact session.
    ///
    /// The message rides the agent event stream scoped to a single
    /// `(worktreeId, tabId, agent)` triple rather than being broadcast, so a
    /// five-way fanout does not type every follow-up into every attempt.
    ///
    /// `delivered` means the input reached the live watcher for that session.
    /// There is no harness-level acknowledgement yet — each TUI would have to
    /// report back that it typed the text — so a watcher that accepts a message
    /// and then fails to submit it is not distinguishable here.
    fn deliver_message(
        &self,
        target: &DeliveryTarget,
        message: &str,
        _message_id: &str,
        wait: bool,
    ) -> FanoutDeliveryState {
        if !self.has_live_session(&target.tab_id) {
            return FanoutDeliveryState::Failed;
        }
        self.report_agent_input(AgentInput {
            agent: target.runtime_agent_id.clone(),
            worktree_id: target.worktree_id.clone(),
            tab_id: target.tab_id.clone(),
            text: message.to_string(),
            request_id: None,
        });
        if !wait {
            return FanoutDeliveryState::Accepted;
        }
        // A watcher is started per live agent session by the supervisor; give a
        // just-launched attempt a bounded window to have one before calling the
        // delivery lost.
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(CONSTANTS.fanout.delivery_timeout_ms.get());
        while std::time::Instant::now() < deadline {
            if self.has_watcher(&target.tab_id) {
                return FanoutDeliveryState::Delivered;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        FanoutDeliveryState::TimedOut
    }

    fn stop_tab(&self, tab_id: &str) {
        let _ = self.kill(tab_id);
        // The watcher set is derived from live sessions, so reconciling now
        // stops this attempt's watcher instead of leaving it until the tick.
        self.reconcile_watchers();
    }

    /// Asks the `pragma-ai` sidecar for a commit message describing the staged
    /// diff. Every failure — no provider, a sidecar crash, an empty message —
    /// is surfaced; the caller must never invent one.
    fn generate_commit_message(&self, root: &str) -> HostResult<String> {
        let diff = staged_diff(root)?;
        if diff.trim().is_empty() {
            return Err(host_error(
                FanoutFailureCode::CommitMessageFailed,
                "nothing is staged to describe",
            ));
        }
        let value = run_ai(&["commit-message", "--cwd", root], &diff)?;
        value
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                host_error(
                    FanoutFailureCode::CommitMessageFailed,
                    "the pragma-ai sidecar returned no commit message",
                )
            })
    }

    fn stage_and_commit(&self, root: &str, message: &str) -> HostResult<Option<String>> {
        git::<Value>(
            &GitRequest::StageAll {
                root: root.to_string(),
            },
            FanoutFailureCode::Internal,
        )?;
        git::<Value>(
            &GitRequest::CommitStaged {
                root: root.to_string(),
                message: message.to_string(),
            },
            FanoutFailureCode::Internal,
        )?;
        Ok(Some(self.head_commit(root)?))
    }

    fn merge_into_parent(&self, parent: &WorktreeView, child: &WorktreeView) -> HostResult<()> {
        git::<Value>(
            &GitRequest::MergeWorktreeToParent {
                parent_root: parent.path.clone(),
                parent_branch: parent.branch.clone(),
                child_root: child.path.clone(),
                child_branch: child.branch.clone(),
            },
            FanoutFailureCode::Internal,
        )
        .map(|_| ())
    }

    fn list_scratchpads(&self, root: &str) -> HostResult<Vec<ScratchpadCopy>> {
        let files = pragma_core::scratchpads::list(root)
            .map_err(|error| host_error(FanoutFailureCode::PromotionFailed, error.to_string()))?;
        Ok(files
            .into_iter()
            .map(|file| {
                let comments = self.read_file(
                    root,
                    &pragma_core::scratchpads::comments_path(&file.file_path),
                );
                ScratchpadCopy {
                    file_path: file.file_path,
                    contents: file.contents,
                    comments,
                }
            })
            .collect())
    }

    fn read_file(&self, root: &str, path: &str) -> Option<String> {
        let resolved = pragma_core::fs::resolve_in_worktree(Path::new(root), path).ok()?;
        std::fs::read_to_string(resolved).ok()
    }

    fn write_file(&self, root: &str, path: &str, contents: &str) -> HostResult<()> {
        let resolved = pragma_core::fs::resolve_in_worktree(Path::new(root), path)
            .map_err(|error| host_error(FanoutFailureCode::PromotionFailed, error.to_string()))?;
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                host_error(FanoutFailureCode::PromotionFailed, error.to_string())
            })?;
        }
        std::fs::write(resolved, contents)
            .map_err(|error| host_error(FanoutFailureCode::PromotionFailed, error.to_string()))
    }

    /// Removes an attempt's checkout and its branch, then drops it from the
    /// mirrored workspace. `force` is deliberate: the attempt was already
    /// merged (or explicitly discarded), and refusing on a stray build artifact
    /// would strand the fanout in `cleanupFailed`.
    fn delete_worktree(&self, worktree: &WorktreeView) -> HostResult<()> {
        let project_root = FanoutHost::project_root(self, &worktree.project_id)?;
        // Sessions rooted in the checkout must die before it is removed, or
        // git refuses and the shell keeps a deleted directory open.
        let _ = self.kill_for_cwd(&worktree.path);
        git::<Value>(
            &GitRequest::RemoveWorktree {
                repo_root: project_root.clone(),
                worktree_path: worktree.path.clone(),
                force: true,
            },
            FanoutFailureCode::CleanupFailed,
        )?;
        git::<Value>(
            &GitRequest::DeleteBranch {
                repo_root: project_root,
                branch: worktree.branch.clone(),
            },
            FanoutFailureCode::CleanupFailed,
        )?;
        self.remove_mirrored_worktree(&worktree.id);
        Ok(())
    }
}

/// True when a catalog agent may be offered for this project root.
///
/// Only `project` scope is exclusive: bundled and global plugins belong to
/// every project. An agent from a catalog that predates scope reporting has no
/// `scope` at all and is treated as shared, which is what it was.
fn belongs_to_project(agent: &Value, project_root: &str) -> bool {
    match agent["scope"].as_str() {
        Some("project") => agent["root"]
            .as_str()
            .is_some_and(|root| Path::new(root) == Path::new(project_root)),
        _ => true,
    }
}

/// The runtime reporter id for a catalog agent.
///
/// The catalog reports it directly when the plugin declares a watcher. The
/// fallback is the last dotted segment, which is what the id was before the
/// catalog carried it — wrong for a plugin whose watcher agent differs, but
/// better than refusing to launch.
fn runtime_agent_id(agent: &Value, catalog_id: &str) -> String {
    agent["runtimeAgentId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map_or_else(
            || {
                catalog_id
                    .rsplit('.')
                    .next()
                    .unwrap_or(catalog_id)
                    .to_string()
            },
            str::to_string,
        )
}

/// Runs the project's `setup` commands in a freshly created checkout.
///
/// The desktop runs these on every worktree it creates; a fanout attempt that
/// skipped them would be missing its dependencies and every agent in it would
/// fail for a reason that has nothing to do with the prompt.
fn run_setup_scripts(project_root: &str, worktree_root: &str, worktree_id: &str) -> HostResult<()> {
    let commands = setup_commands(project_root);
    if commands.is_empty() {
        return Ok(());
    }
    let request = ExecRequest {
        cwd: worktree_root.to_string(),
        commands,
        env: vec![
            (
                "PRAGMA_WORKTREE_PATH".to_string(),
                worktree_root.to_string(),
            ),
            ("PRAGMA_PROJECT_PATH".to_string(), project_root.to_string()),
            ("PRAGMA_WORKTREE_ID".to_string(), worktree_id.to_string()),
        ],
        max_concurrent: u32::try_from(CONSTANTS.scripts.max_concurrent_commands.get()).unwrap_or(1),
    };
    let payload = serde_json::to_value(&request)
        .map_err(|error| host_error(FanoutFailureCode::SetupFailed, error.to_string()))?;
    let value = pragma_core::exec::handle(payload)
        .map_err(|error| host_error(FanoutFailureCode::SetupFailed, error.to_string()))?;
    let results: Vec<CommandResult> = serde_json::from_value(value)
        .map_err(|error| host_error(FanoutFailureCode::SetupFailed, error.to_string()))?;
    let failures: Vec<&CommandResult> = results
        .iter()
        .filter(|result| result.status != Some(0))
        .collect();
    if failures.is_empty() {
        return Ok(());
    }
    let detail = failures
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
        .join("; ");
    Err(host_error(
        FanoutFailureCode::SetupFailed,
        format!("setup scripts failed: {detail}"),
    ))
}

/// The project's `setup` commands, or none when it has no scripts file. A
/// malformed file is treated as "no setup" rather than failing every attempt.
fn setup_commands(project_root: &str) -> Vec<String> {
    let path = Path::new(project_root).join(CONSTANTS.scripts.config_path.as_str());
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("setup").cloned())
        .and_then(|setup| serde_json::from_value::<Vec<String>>(setup).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|command| !command.trim().is_empty())
        .collect()
}

fn staged_diff(root: &str) -> HostResult<String> {
    let output = pragma_core::process_env::git()
        .arg("-C")
        .arg(root)
        .args(["diff", "--cached"])
        .output()
        .map_err(|error| host_error(FanoutFailureCode::CommitMessageFailed, error.to_string()))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs one `pragma-ai` one-shot command, writing `stdin` and returning its
/// final NDJSON event.
fn run_ai(args: &[&str], stdin: &str) -> HostResult<Value> {
    use std::io::Write;

    let mut command = ai_command();
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| host_error(FanoutFailureCode::CommitMessageFailed, error.to_string()))?;
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(stdin.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| host_error(FanoutFailureCode::CommitMessageFailed, error.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .ok_or_else(|| {
            host_error(
                FanoutFailureCode::CommitMessageFailed,
                format!(
                    "the pragma-ai sidecar produced no output ({})",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            )
        })?;
    let value: Value = serde_json::from_str(last)
        .map_err(|error| host_error(FanoutFailureCode::CommitMessageFailed, error.to_string()))?;
    if value.get("type").and_then(Value::as_str) == Some("error") {
        return Err(host_error(
            FanoutFailureCode::CommitMessageFailed,
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("pragma-ai error")
                .to_string(),
        ));
    }
    Ok(value)
}

/// The `pragma-ai` sidecar, resolved the same way the automations sidecar is.
fn ai_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = pragma_platform::process::command("bun");
        command
            .arg("packages/ai-helpers/src/cli.ts")
            .current_dir(workspace_root());
        command
    } else {
        pragma_platform::process::command(
            sidecar_executable(&executable_name("pragma-ai"))
                .to_string_lossy()
                .as_ref(),
        )
    }
}

/// Appends the platform's executable suffix, so `pragma-ai` resolves to
/// `pragma-ai.exe` on Windows.
fn executable_name(name: &str) -> String {
    let suffix = std::env::consts::EXE_SUFFIX;
    if suffix.is_empty() || name.ends_with(suffix) {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    }
}

fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::{belongs_to_project, runtime_agent_id, setup_commands};
    use serde_json::json;

    #[test]
    fn a_project_scoped_agent_belongs_only_to_its_own_root() {
        let agent = json!({ "scope": "project", "root": "/repos/beta" });
        assert!(belongs_to_project(&agent, "/repos/beta"));
        assert!(!belongs_to_project(&agent, "/repos/alpha"));
    }

    #[test]
    fn global_and_unscoped_agents_belong_to_every_project() {
        assert!(belongs_to_project(
            &json!({ "scope": "global", "root": "/home/user" }),
            "/repos/alpha"
        ));
        assert!(belongs_to_project(
            &json!({ "id": "legacy" }),
            "/repos/alpha"
        ));
    }

    #[test]
    fn the_runtime_id_comes_from_the_catalog_before_the_dotted_fallback() {
        assert_eq!(
            runtime_agent_id(
                &json!({ "runtimeAgentId": "opencode-nightly" }),
                "pragma.opencode.beta"
            ),
            "opencode-nightly"
        );
        assert_eq!(runtime_agent_id(&json!({}), "pragma.opencode"), "opencode");
    }

    #[test]
    fn setup_commands_tolerate_a_missing_or_malformed_scripts_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let root = directory.path().to_string_lossy().into_owned();
        assert!(setup_commands(&root).is_empty());

        let scripts = directory
            .path()
            .join(pragma_constants::CONSTANTS.scripts.config_path.as_str());
        std::fs::create_dir_all(scripts.parent().expect("parent")).expect("dirs");
        std::fs::write(&scripts, "{ not json").expect("write");
        assert!(setup_commands(&root).is_empty());

        std::fs::write(&scripts, r#"{ "setup": ["bun install", "  "] }"#).expect("write");
        assert_eq!(setup_commands(&root), vec!["bun install".to_string()]);
    }
}
