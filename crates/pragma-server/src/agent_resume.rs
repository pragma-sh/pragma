//! Preparing, restoring, and tracking durable agent invocations.
//!
//! This is the `Registry`-facing half of [`crate::invocations`]. A desktop
//! launch asks the host to prepare the command before typing it (so a
//! supported agent runs under `pragma-cli agent run --run-id …`), and a tab
//! whose PTY is gone after a crash or native-update quit asks the same host to
//! resume the harness conversation that was last reported.
//!
//! The rules that matter:
//!
//! - **Resume only an interrupted, still-open session.** The record must have
//!   been `Active` when its server stopped, must carry a harness session id,
//!   and the tab must still exist (and not be tombstoned). A record that never
//!   started, or one whose child exited, is never restored.
//! - **The callback owns the argv.** The plugin's `launch.resume` result is
//!   used verbatim — no model args, startup input, or prompt is appended — and
//!   it is wrapped only in the supervisor that reports the child's exit.
//! - **A missing callback or a resume error is a failed record, never a
//!   fallback.** The record keeps its harness id and selection so an explicit
//!   retry can pick it up; nothing launches a fresh or latest conversation in
//!   its place.
//! - **Every resume is a new execution.** The record rotates to a fresh run id
//!   before the resumed wrapper is spawned, so a stale wrapper's end report
//!   (or a late session-id report) can neither end nor re-point the new
//!   execution. The record stays `interrupted` until the resumed wrapper's
//!   `startRun` acknowledges the child actually started.
//! - **One restore per tab, and the final spawn is serialized with the tab's
//!   lifecycle.** A per-tab coordinator makes a second caller wait for the
//!   winner's outcome instead of reporting "nothing to restore", and a per-tab
//!   gate makes the revalidate-rotate-spawn-write section atomic against a
//!   close, kill, session exit, or new launch.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use pragma_constants::AgentResumeRequest;
use pragma_core::tabs::{PreparedAgentLaunch, RestoreAgentSessionResult};
use serde_json::Value;
use uuid::Uuid;

use crate::invocations::{InvocationRecord, InvocationState, NewInvocation};
use crate::plugins_host::PluginsRegistry;
use crate::registry::Registry;

/// The plugin callback a resume runs through. A trait rather than a direct
/// call only so tests can substitute a deterministic callback; the production
/// implementation is [`PluginsRegistry::resume_agent`].
pub(crate) trait ResumeCallback: Send + Sync {
    /// Returns the full argv that resumes the conversation, or the reason the
    /// callback could not.
    fn resume(
        &self,
        agent_id: &str,
        project_root: &str,
        request: &AgentResumeRequest,
    ) -> Result<Vec<String>, String>;
}

impl ResumeCallback for PluginsRegistry {
    fn resume(
        &self,
        agent_id: &str,
        project_root: &str,
        request: &AgentResumeRequest,
    ) -> Result<Vec<String>, String> {
        self.resume_agent(agent_id, project_root, request)
            .map_err(|error| error.to_string())
    }
}

/// How long a caller that lost the restore race waits for the winner's
/// outcome. Longer than the resume callback's own sidecar timeout, because
/// reporting "nothing to restore" while a winner is still working would make
/// the desktop spawn a fresh shell over a session that is about to exist.
const RESTORE_WAIT: Duration = Duration::from_secs(45);

/// One in-flight restore for a tab, and the outcome its followers wait for.
struct RestoreSlot {
    outcome: Mutex<Option<Result<(), String>>>,
    done: Condvar,
}

/// Serializes restores per tab: one owner runs the restore, everyone else
/// waits for its outcome rather than racing a second spawn or claiming there
/// is nothing to restore.
pub(crate) struct RestoreCoordinator {
    slots: Mutex<HashMap<String, Arc<RestoreSlot>>>,
    progress: Mutex<pragma_core::tabs::SessionRestoreSnapshot>,
}

impl RestoreCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            progress: Mutex::new(pragma_core::tabs::SessionRestoreSnapshot {
                boot_id: uuid::Uuid::new_v4().to_string(),
                startup_complete: false,
                sessions: Vec::new(),
            }),
        }
    }

    fn begin(self: &Arc<Self>, tab_id: &str) -> RestoreEntry {
        let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slot) = slots.get(tab_id) {
            return RestoreEntry::Follower(Arc::clone(slot));
        }
        let slot = Arc::new(RestoreSlot {
            outcome: Mutex::new(None),
            done: Condvar::new(),
        });
        slots.insert(tab_id.to_string(), Arc::clone(&slot));
        let mut progress = self.progress.lock().unwrap_or_else(PoisonError::into_inner);
        progress.sessions.retain(|session| session.tab_id != tab_id);
        progress
            .sessions
            .push(pragma_core::tabs::SessionRestoreProgress {
                tab_id: tab_id.to_string(),
                title: String::new(),
                complete: false,
                error: None,
            });
        RestoreEntry::Owner(RestoreClaim {
            coordinator: Arc::clone(self),
            slot,
            tab_id: tab_id.to_string(),
            settled: false,
        })
    }

    pub(crate) fn snapshot(&self) -> pragma_core::tabs::SessionRestoreSnapshot {
        self.progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn finish_startup(&self) {
        self.progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .startup_complete = true;
    }
}

enum RestoreEntry {
    Owner(RestoreClaim),
    Follower(Arc<RestoreSlot>),
}

/// The owner's handle on one tab's restore slot. Settling publishes the
/// outcome and wakes every follower; dropping without settling publishes a
/// failure so a panicking restore cannot strand its waiters.
struct RestoreClaim {
    coordinator: Arc<RestoreCoordinator>,
    slot: Arc<RestoreSlot>,
    tab_id: String,
    settled: bool,
}

impl RestoreClaim {
    fn settle(mut self, result: Result<(), String>) {
        self.settled = true;
        self.publish(result);
    }

    fn publish(&self, result: Result<(), String>) {
        if let Ok(mut progress) = self.coordinator.progress.lock() {
            if let Some(session) = progress
                .sessions
                .iter_mut()
                .find(|session| session.tab_id == self.tab_id)
            {
                session.complete = true;
                session.error = result.as_ref().err().cloned();
            }
        }
        if let Ok(mut outcome) = self.slot.outcome.lock() {
            *outcome = Some(result);
        }
        self.slot.done.notify_all();
        if let Ok(mut slots) = self.coordinator.slots.lock() {
            slots.remove(&self.tab_id);
        }
    }
}

impl Drop for RestoreClaim {
    fn drop(&mut self) {
        if !self.settled {
            self.publish(Err("the restore did not finish".to_string()));
        }
    }
}

/// Waits, bounded, for the restore owner's outcome.
fn wait_for_restore(slot: &RestoreSlot) -> Result<(), String> {
    let mut outcome = slot.outcome.lock().unwrap_or_else(PoisonError::into_inner);
    loop {
        if let Some(result) = outcome.clone() {
            return result;
        }
        let (guard, wait) = slot
            .done
            .wait_timeout(outcome, RESTORE_WAIT)
            .unwrap_or_else(PoisonError::into_inner);
        outcome = guard;
        if wait.timed_out() && outcome.is_none() {
            return Err("another restore is already running for this tab".to_string());
        }
    }
}

/// The effective launch choices a server-owned (headless) launch made, in the
/// shape the durable record and the resume request share.
pub(crate) fn selection_from_launch(
    launch: &crate::registry::AgentLaunch,
) -> pragma_constants::AgentLaunchSelection {
    pragma_constants::AgentLaunchSelection {
        model_id: launch.model_id.clone(),
        reasoning_id: launch.reasoning_id.clone(),
        mode_id: launch.options.mode_id.clone(),
        permission_mode_id: launch.options.permission_mode_id.clone(),
        slash_command: launch.options.slash_command.clone(),
    }
}

fn no_selection() -> pragma_constants::AgentLaunchSelection {
    pragma_constants::AgentLaunchSelection {
        model_id: None,
        reasoning_id: None,
        mode_id: None,
        permission_mode_id: None,
        slash_command: None,
    }
}

/// Parses the `prepareAgentLaunch` selection. An absent or null selection is
/// the empty set; a malformed value fails the prepare rather than recording a
/// resume that cannot reproduce the launch.
pub(crate) fn selection_from_value(
    selection: Option<&Value>,
) -> Result<pragma_constants::AgentLaunchSelection, String> {
    let Some(value) = selection.filter(|value| !value.is_null()) else {
        return Ok(no_selection());
    };
    let Some(object) = value.as_object() else {
        return Err(format!("invalid agent launch selection: {value}"));
    };
    // Read field by field: an omitted key is "no choice", exactly like a null
    // one, and a wrong type is a prepare error rather than a silently dropped
    // choice a resume could not reproduce.
    let field = |key: &str| -> Result<Option<String>, String> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(other) => Err(format!("invalid agent launch selection `{key}`: {other}")),
        }
    };
    Ok(pragma_constants::AgentLaunchSelection {
        model_id: field("modelId")?,
        reasoning_id: field("reasoningId")?,
        mode_id: field("modeId")?,
        permission_mode_id: field("permissionModeId")?,
        slash_command: field("slashCommand")?,
    })
}

/// What a successful `startRun` returns: the child's env and the server boot
/// that authorized this execution. The wrapper echoes the boot id on
/// `finishRun`, so a late report from a previous boot is rejected instead of
/// ending the record the current boot is recovering.
#[derive(Debug)]
pub(crate) struct AuthorizedRun {
    pub env: Vec<(String, String)>,
    pub server_boot_id: String,
}

/// What a caller asks the host to prepare.
pub(crate) struct PrepareLaunch {
    pub tab_id: String,
    pub worktree_id: String,
    pub agent_id: String,
    pub command: Vec<String>,
    pub selection: Option<Value>,
}

impl Registry {
    /// Records an agent invocation and returns the run id the caller's command
    /// must carry. The tab gate makes the record swap atomic against a restore
    /// that is between its resume callback and its spawn.
    ///
    /// `shell` is the tab's shell at prepare time (the restore returns to it);
    /// `command` is the literal argv the caller supplied. `accounts` are the
    /// effective account references (never credentials) the caller resolved;
    /// they are deliberately passed in rather than looked up here, because
    /// resolving them reaches the plugins sidecar and a record must be cheap
    /// to write.
    // Identity, geometry, choices, shell, and accounts are independent axes of
    // one record; bundling them into a struct would only move the argument
    // list. Mirrors `Registry::spawn_with_env`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_invocation(
        &self,
        tab_id: &str,
        worktree_id: &str,
        project_id: &str,
        cwd: &str,
        agent_id: &str,
        command: &[String],
        selection: pragma_constants::AgentLaunchSelection,
        shell: Option<pragma_constants::ShellProfile>,
        accounts: Vec<pragma_constants::AccountSessionUse>,
    ) -> Result<String, String> {
        let gate = self.tab_gate(tab_id);
        let _guard = gate.lock().unwrap_or_else(PoisonError::into_inner);
        // The catalog/account lookups before this point are slow; a tab
        // closed while they ran must not get a tracked launch at all. (The
        // mirror's snapshot lags the desktop's tab creation, so "not in the
        // snapshot" alone is not evidence of a close — the tombstone is.)
        if self.tab_is_tombstoned(tab_id) {
            return Err("tab was closed before the launch could be prepared".to_string());
        }
        let prepared = self
            .invocations
            .prepare(&NewInvocation {
                tab_id: tab_id.to_string(),
                worktree_id: worktree_id.to_string(),
                project_id: Some(project_id.to_string()),
                agent_id: agent_id.to_string(),
                cwd: cwd.to_string(),
                shell,
                command: command.to_vec(),
                selection,
                accounts,
            })
            .map_err(|error| error.to_string())?;
        Ok(prepared.run_id)
    }

    /// Handles the desktop's `prepareAgentLaunch` op.
    pub(crate) fn handle_prepare_agent_launch(
        &self,
        prepare: PrepareLaunch,
    ) -> Result<PreparedAgentLaunch, String> {
        if prepare.worktree_id
            == pragma_constants::CONSTANTS
                .mini_window
                .home_worktree_id
                .as_str()
        {
            // Mini's home tab is a temporary shell context, not a workspace
            // worktree. Keep its launches untracked rather than requiring a
            // durable invocation row that cannot be tied to a project.
            let cwd = pragma_platform::path::home_dir()
                .ok_or_else(|| "could not resolve the home directory for Mini".to_string())?
                .to_string_lossy()
                .into_owned();
            let command_line = self.command_line_for_tab(&prepare.tab_id, &cwd, &prepare.command);
            return Ok(PreparedAgentLaunch {
                command: prepare.command,
                run_id: None,
                command_line: Some(command_line),
            });
        }
        let (project_id, cwd) = self
            .worktree_location(&prepare.worktree_id)
            .map_err(|error| error.to_string())?;
        let project_root = self.project_root(&project_id)?;
        let catalog = self.project_catalog(&project_root)?;
        let agent = catalog["agents"]
            .as_array()
            .and_then(|agents| agents.iter().find(|agent| agent["id"] == prepare.agent_id))
            .ok_or_else(|| format!("agent not found: {}", prepare.agent_id))?;
        if agent["supportsResume"] != Value::Bool(true) {
            // A user command, or an agent that did not opt into resume: the
            // caller's argv goes back untouched and nothing is recorded. The
            // quoted line still saves the caller the same shell guessing.
            let command_line = self.command_line_for_tab(&prepare.tab_id, &cwd, &prepare.command);
            return Ok(PreparedAgentLaunch {
                command: prepare.command,
                run_id: None,
                command_line: Some(command_line),
            });
        }
        let mut selection = selection_from_value(prepare.selection.as_ref())?;
        // Record the effective mode and permission mode, not the caller's
        // omission: a later change to the agent's defaults must not change what
        // resuming this launch means.
        crate::agent_options::effective_selection(agent, &mut selection)?;
        let shell = self.mirrored_tab(&prepare.tab_id).and_then(|tab| tab.shell);
        // Effective account references, never credentials: a resume returns to
        // the same logins even if the effective binding moved since.
        let accounts = self.accounts.effective_references(
            self,
            &prepare.agent_id,
            Some(project_root.as_str()),
        )?;
        let run_id = self.prepare_invocation(
            &prepare.tab_id,
            &prepare.worktree_id,
            &project_id,
            &cwd,
            &prepare.agent_id,
            &prepare.command,
            selection,
            shell,
            accounts,
        )?;
        let command = self.wrap_agent_run(&run_id, &prepare.command);
        let command_line = self.command_line_for_tab(&prepare.tab_id, &cwd, &command);
        Ok(PreparedAgentLaunch {
            command,
            run_id: Some(run_id),
            command_line: Some(command_line),
        })
    }

    /// Quotes `argv` for the shell the tab runs: the live session's own
    /// program when it exists, otherwise the shell a spawn in `cwd` would
    /// resolve (project `terminal` config, then global, then the platform
    /// default). The caller can type the result without re-deriving quoting.
    fn command_line_for_tab(&self, tab_id: &str, cwd: &str, argv: &[String]) -> String {
        let program = self.session(tab_id).map_or_else(
            |_| crate::session::resolve_session_shell(cwd, None).program,
            |session| session.shell_program().to_string(),
        );
        crate::registry::agent_command_line(argv, &program)
    }

    /// Handles the desktop's `restoreAgentSession` op.
    ///
    /// A live session is reported restored (the caller reattaches) rather than
    /// duplicated. `restored: false` means there is no eligible record. An
    /// eligible record whose resume fails is an error — the caller must see
    /// the difference, because its only alternative is a fresh shell. A caller
    /// that races another restore waits for that restore's outcome instead of
    /// being told there is nothing to restore.
    pub(crate) fn handle_restore_agent_session(
        &self,
        tab_id: &str,
        worktree_id: &str,
    ) -> Result<RestoreAgentSessionResult, String> {
        if self.has_live_session(tab_id) {
            return Ok(RestoreAgentSessionResult { restored: true });
        }
        if self.tab_is_tombstoned(tab_id) {
            return Ok(RestoreAgentSessionResult { restored: false });
        }
        let record = self
            .invocations
            .resumable_for_tab(worktree_id, tab_id)
            .map_err(|error| error.to_string())?;
        let Some(record) = record else {
            return Ok(RestoreAgentSessionResult { restored: false });
        };
        match self.restore.begin(tab_id) {
            RestoreEntry::Follower(slot) => {
                // A restore is already running: its outcome is ours. Reporting
                // `false` here would let the caller spawn a fresh shell over a
                // session the winner is about to create.
                wait_for_restore(&slot)?;
                Ok(RestoreAgentSessionResult { restored: true })
            }
            RestoreEntry::Owner(claim) => {
                // The desktop is mounting the tab, so its own publish may not
                // have landed: only the tombstone has to hold here.
                let result = self.restore_record(&record, false);
                claim.settle(result.clone());
                result.map(|()| RestoreAgentSessionResult { restored: true })
            }
        }
    }

    /// Authorizes the supervised child of `pragma-cli agent run` to start, and
    /// returns the environment the child must run with.
    ///
    /// This is the last gate before an agent process exists, so it validates
    /// the state the launch depends on: the run id must be current (not stale,
    /// ended, or superseded), its tab must not be closed, and the tab's
    /// session must still be live — a delayed spawn after the tab went away
    /// must not launch a wrapper nobody owns. The returned env is resolved
    /// *now* from the record's saved account references, so the child runs
    /// under the account the launch was prepared with even if the shell's own
    /// spawn-time env timed out or a binding moved; a resolution failure is an
    /// error, never a silent fall back to another login. Empty references are
    /// the explicit default provenance and yield an empty env without
    /// re-resolving the current binding.
    pub(crate) fn handle_start_run(&self, run_id: &str) -> Result<AuthorizedRun, String> {
        let record = self
            .invocations
            .record(run_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("stale agent run: {run_id}"))?;
        if self.tab_is_tombstoned(&record.tab_id) {
            return Err(format!("agent run rejected: tab was closed: {run_id}"));
        }
        if !self.has_live_session(&record.tab_id) {
            return Err(format!(
                "agent run rejected: tab has no live session: {run_id}"
            ));
        }
        let project_root = record
            .project_id
            .as_deref()
            .and_then(|project_id| self.project_root(project_id).ok())
            .unwrap_or_else(|| record.cwd.clone());
        let env = self
            .accounts
            .launch_env_for_references(
                self,
                &record.agent_id,
                Some(project_root.as_str()),
                Some(&record.tab_id),
                &record.accounts,
            )
            .inspect_err(|reason| self.fail_record(run_id, reason))?;
        match self.invocations.start(run_id) {
            Ok(true) => Ok(AuthorizedRun {
                env,
                server_boot_id: self.plugins().boot_id().to_string(),
            }),
            Ok(false) => Err(format!("stale agent run: {run_id}")),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Marks the supervised child exited. This is the only signal that closes
    /// an invocation.
    ///
    /// A report that carries the authorizing boot id is rejected as stale
    /// before the record is touched when that id is not this boot: a wrapper
    /// that outlived a server SIGKILL keeps retrying `finishRun` with the old
    /// run id, which is still the *current* execution id on the restarted
    /// server (recovery rotates only after it starts). Without this token the
    /// late report would end an interrupted record and suppress the restore.
    /// A legacy report without a token keeps the old semantics.
    pub(crate) fn handle_finish_run(
        &self,
        run_id: &str,
        exit_code: Option<i32>,
        server_boot_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(boot_id) = server_boot_id {
            let current = self.plugins().boot_id();
            if boot_id != current {
                return Err(format!(
                    "stale agent run: {run_id} (authorized by boot {boot_id}, current boot {current})"
                ));
            }
        }
        match self.invocations.finish(run_id, exit_code) {
            Ok(true) => Ok(()),
            Ok(false) => Err(format!("stale agent run: {run_id}")),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(crate) fn handle_fail_run(
        &self,
        run_id: &str,
        reason: &str,
        server_boot_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(boot_id) = server_boot_id {
            let current = self.plugins().boot_id();
            if boot_id != current {
                return Err(format!(
                    "stale agent run: {run_id} (authorized by boot {boot_id}, current boot {current})"
                ));
            }
        }
        let record = self
            .invocations
            .record(run_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("stale agent run: {run_id}"))?;
        if !matches!(
            record.state,
            InvocationState::Active | InvocationState::Interrupted | InvocationState::Failed
        ) {
            return Err(format!("stale agent run: {run_id}"));
        }
        self.fail_record(run_id, reason);
        Ok(())
    }

    /// Proactively restores every interrupted invocation whose tab is still
    /// open — including tabs no client currently has mounted. Runs once at
    /// startup, after plugin roots and the catalog can resolve.
    ///
    /// A restore that fails is retried briefly on this pass (the sidecar may
    /// still be starting), then left `failed` and recoverable; an explicit
    /// desktop mount can retry it later.
    pub(crate) fn reconcile_invocations(&self) {
        const RESTORE_ATTEMPTS: usize = 2;
        const RESTORE_RETRY_DELAY: Duration = Duration::from_secs(3);

        let records = match self.invocations.interrupted_and_resumable() {
            Ok(records) => records,
            Err(error) => {
                eprintln!("agent invocations: cannot read interrupted runs: {error}");
                self.restore.finish_startup();
                return;
            }
        };
        for record in records {
            if !self.tab_is_open(&record.tab_id) {
                continue;
            }
            if self.has_live_session(&record.tab_id) {
                continue;
            }
            let RestoreEntry::Owner(claim) = self.restore.begin(&record.tab_id) else {
                // A desktop restore is already handling this tab.
                continue;
            };
            let mut last_error = None;
            for attempt in 0..RESTORE_ATTEMPTS {
                if self.has_live_session(&record.tab_id) {
                    last_error = None;
                    break;
                }
                match self.restore_record(&record, true) {
                    Ok(()) => {
                        last_error = None;
                        break;
                    }
                    Err(error) => last_error = Some(error),
                }
                if attempt + 1 < RESTORE_ATTEMPTS {
                    std::thread::sleep(RESTORE_RETRY_DELAY);
                }
            }
            claim.settle(last_error.clone().map_or(Ok(()), Err));
            if let Some(error) = last_error {
                eprintln!(
                    "agent invocations: could not restore run {} on tab {}: {error}",
                    record.run_id, record.tab_id
                );
            }
        }
        self.restore.finish_startup();
    }

    /// Resumes one recorded harness conversation into its original tab, under
    /// a fresh execution id.
    ///
    /// The resume callback and account resolution run outside the tab gate (a
    /// sidecar round trip must not block a close); the revalidation, execution
    /// rotation, spawn, and command write run inside it, so a close, kill, or
    /// new launch either happens entirely before (and aborts the restore) or
    /// entirely after (and retires the just-restored session).
    ///
    /// `require_open` is the proactive pass's rule: it may only restore a tab
    /// the mirrored workspace still carries. An on-demand desktop restore
    /// skips that check (the caller is mounting the tab, and its publish may
    /// not have landed yet) but still honors the tombstone.
    fn restore_record(&self, record: &InvocationRecord, require_open: bool) -> Result<(), String> {
        // Re-read the record first: a retry after a failed attempt may have
        // rotated the execution id, and every failure below must be recorded
        // against the execution that is actually current.
        let current = self
            .invocations
            .latest_for_tab(&record.worktree_id, &record.tab_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "invocation disappeared before restore".to_string())?;
        if current.invocation_id != record.invocation_id || !current.is_explicitly_restorable() {
            return Err("invocation is no longer restorable".to_string());
        }
        let record = current;
        let Some(harness_session_id) = record.harness_session_id.clone() else {
            return Err("invocation has no harness session id".to_string());
        };
        let project_root = record
            .project_id
            .as_deref()
            .and_then(|project_id| self.project_root(project_id).ok())
            .unwrap_or_else(|| record.cwd.clone());
        let request = AgentResumeRequest {
            harness_session_id,
            selection: record.selection.clone(),
            cwd: record.cwd.clone(),
        };
        // Clone the callback out before calling: building the argv may take a
        // sidecar round trip, and the lock must not be held across it.
        let callback = self
            .resume_callback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let argv = callback
            .resume(&record.agent_id, &project_root, &request)
            .inspect_err(|reason| self.fail_record(&record.run_id, reason))?;
        // Only a launch that recorded account references has logins to
        // rebind. With none recorded the resumed session starts on the
        // harness's own default login — the same fallback the original launch
        // used when it had no accounts. A recorded reference that cannot be
        // resolved is an error: starting under a *different* account than the
        // conversation was created with is worse than not resuming.
        let tab = self.mirrored_tab(&record.tab_id);
        let mut env = fanout_env(tab.as_ref());
        if !record.accounts.is_empty() {
            env.extend(
                self.accounts
                    .launch_env_for_references(
                        self,
                        &record.agent_id,
                        Some(project_root.as_str()),
                        Some(&record.tab_id),
                        &record.accounts,
                    )
                    .inspect_err(|reason| self.fail_record(&record.run_id, reason))?,
            );
        }

        // Final section: revalidate, rotate, spawn, and hand over the command
        // as one unit against the tab's lifecycle.
        self.spawn_resumed_session(&record, &argv, &env, require_open)
    }

    /// The atomic tail of a restore: under the tab gate, revalidate the
    /// record, rotate it onto a fresh execution, spawn the session, and type
    /// the wrapped resume command into it.
    fn spawn_resumed_session(
        &self,
        record: &InvocationRecord,
        argv: &[String],
        env: &[(String, String)],
        require_open: bool,
    ) -> Result<(), String> {
        let gate = self.tab_gate(&record.tab_id);
        let _guard = gate.lock().unwrap_or_else(PoisonError::into_inner);
        if self.tab_is_tombstoned(&record.tab_id) {
            return Err("tab was closed before the session could be restored".to_string());
        }
        if require_open && !self.tab_is_open(&record.tab_id) {
            return Err("tab is no longer open".to_string());
        }
        // A wrapper whose finish could not reach the host may have journaled
        // its exit after the startup replay ran. Apply those now, under the
        // gate, so the revalidation below sees a completed execution and
        // aborts instead of rotating a run that already ended.
        if let Err(error) = self.invocations.replay_completions(&self.completions_dir()) {
            return Err(format!("could not read the completion journal: {error}"));
        }
        // A live wrapper is the session; rotating its execution id out from
        // under it would make its own end report stale. A follower that
        // arrived after the winner left the coordinator slot must not rotate.
        if self.has_live_session(&record.tab_id) {
            return Ok(());
        }
        let current = self
            .invocations
            .latest_for_tab(&record.worktree_id, &record.tab_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "invocation disappeared before restore".to_string())?;
        if current.invocation_id != record.invocation_id || !current.is_explicitly_restorable() {
            return Err("invocation is no longer restorable".to_string());
        }
        let new_run_id = Uuid::new_v4().to_string();
        if !self
            .invocations
            .rotate_execution(&current.invocation_id, &new_run_id)
            .map_err(|error| error.to_string())?
        {
            return Err("invocation is no longer restorable".to_string());
        }
        let wrapped = self.wrap_agent_run(&new_run_id, argv);

        match self.spawn_with_env(
            record.tab_id.clone(),
            record.worktree_id.clone(),
            record.cwd.clone(),
            crate::registry::AGENT_SESSION_COLS,
            crate::registry::AGENT_SESSION_ROWS,
            record.shell.clone(),
            env,
        ) {
            Ok(_) => {}
            // Another restore won the spawn race; the caller attaches to it.
            Err(crate::registry::RegistryError::AlreadyExists(_)) => return Ok(()),
            Err(error) => {
                let reason = error.to_string();
                self.fail_record(&new_run_id, &reason);
                return Err(reason);
            }
        }
        // The shell needs a moment before typed input lands at its prompt —
        // the same readiness wait every other launch uses. Quoting follows the
        // program this session actually runs, never a re-resolution.
        thread::sleep(Duration::from_millis(
            pragma_constants::CONSTANTS.agents.start_delay_ms,
        ));
        let session = match self.session(&record.tab_id) {
            Ok(session) => session,
            Err(error) => {
                let reason = format!("resumed session disappeared: {error}");
                self.fail_record(&new_run_id, &reason);
                return Err(reason);
            }
        };
        let command = crate::registry::agent_command_line(&wrapped, session.shell_program());
        if let Err(error) = self.write(&record.tab_id, &format!("{command}\r")) {
            self.discard_session(&record.tab_id);
            let reason = format!("could not start the resumed session: {error}");
            self.fail_record(&new_run_id, &reason);
            return Err(reason);
        }
        // The record stays `interrupted` until the wrapper's `startRun`
        // acknowledges the child: a restore that never actually ran must be
        // eligible again after the next server start.
        self.reconcile_watchers();
        Ok(())
    }

    fn fail_record(&self, run_id: &str, reason: &str) {
        if let Err(error) = self.invocations.fail(run_id, reason) {
            eprintln!("agent invocations: could not record failure for {run_id}: {error}");
        }
    }
}

/// The fanout identity a restored session must keep exporting, from its
/// mirrored tab row.
fn fanout_env(tab: Option<&pragma_constants::Tab>) -> Vec<(String, String)> {
    let Some(tab) = tab else {
        return Vec::new();
    };
    let Some(fanout_id) = tab.fanout_id.as_ref() else {
        return Vec::new();
    };
    let mut env = vec![(
        pragma_constants::CONSTANTS.fanout.env_fanout_id.clone(),
        fanout_id.clone(),
    )];
    if let Some(member_id) = tab.fanout_member_id.as_ref() {
        env.push((
            pragma_constants::CONSTANTS.fanout.env_member_id.clone(),
            member_id.clone(),
        ));
    }
    env
}

#[cfg(test)]
mod tests {
    #[test]
    fn recovery_progress_is_boot_scoped_and_tracks_outcomes() {
        let coordinator = std::sync::Arc::new(super::RestoreCoordinator::new());
        let initial = coordinator.snapshot();
        assert!(!initial.startup_complete);
        assert!(initial.sessions.is_empty());
        assert_ne!(
            initial.boot_id,
            super::RestoreCoordinator::new().snapshot().boot_id
        );
        let super::RestoreEntry::Owner(claim) = coordinator.begin("tab-1") else {
            panic!("first restore owns the slot");
        };
        assert!(!coordinator.snapshot().sessions[0].complete);
        claim.settle(Err("missing CLI".to_string()));
        coordinator.finish_startup();
        let failed = coordinator.snapshot();
        assert!(failed.startup_complete);
        assert!(failed.sessions[0].complete);
        assert_eq!(failed.sessions[0].error.as_deref(), Some("missing CLI"));
        let super::RestoreEntry::Owner(retry) = coordinator.begin("tab-1") else {
            panic!("retry owns the released slot");
        };
        retry.settle(Ok(()));
        let restored = coordinator.snapshot();
        assert_eq!(restored.sessions.len(), 1);
        assert!(restored.sessions[0].complete);
        assert!(restored.sessions[0].error.is_none());
    }

    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Instant;

    use pragma_constants::{AgentStatus, Project, Tab, TabKind, WorkspaceSnapshot, Worktree};
    use pragma_protocol::AgentReportPayload;
    use tempfile::tempdir;

    use super::*;
    use crate::invocations::{
        completions_dir, invocations_path, InvocationState, InvocationStore, NewInvocation,
    };

    /// A deterministic `launch.resume` callback: errors on demand, records how
    /// many times it ran.
    struct FakeResume {
        argv: Mutex<Result<Vec<String>, String>>,
        calls: Mutex<usize>,
    }

    impl FakeResume {
        fn returning(argv: &[&str]) -> Arc<Self> {
            Arc::new(Self {
                argv: Mutex::new(Ok(argv.iter().map(|part| (*part).to_string()).collect())),
                calls: Mutex::new(0),
            })
        }

        fn failing(reason: &str) -> Arc<Self> {
            Arc::new(Self {
                argv: Mutex::new(Err(reason.to_string())),
                calls: Mutex::new(0),
            })
        }

        fn calls(&self) -> usize {
            *self.calls.lock().expect("calls")
        }
    }

    impl ResumeCallback for FakeResume {
        fn resume(
            &self,
            _agent_id: &str,
            _project_root: &str,
            _request: &AgentResumeRequest,
        ) -> Result<Vec<String>, String> {
            *self.calls.lock().expect("calls") += 1;
            self.argv.lock().expect("argv").clone()
        }
    }

    /// A resume that blocks until the test releases it, so a second caller
    /// arrives while the first is still inside the callback.
    struct GatedResume {
        entered: Arc<std::sync::Barrier>,
        release: Arc<std::sync::Barrier>,
    }

    impl ResumeCallback for GatedResume {
        fn resume(
            &self,
            _agent_id: &str,
            _project_root: &str,
            _request: &AgentResumeRequest,
        ) -> Result<Vec<String>, String> {
            self.entered.wait();
            self.release.wait();
            Ok(vec!["fake-agent".to_string(), "--resume".to_string()])
        }
    }

    /// A resume that runs an arbitrary side effect mid-callback, used to prove
    /// a close or a new launch is revalidated before the spawn.
    struct CallbackAction {
        action: Box<dyn Fn() + Send + Sync>,
    }

    impl ResumeCallback for CallbackAction {
        fn resume(
            &self,
            _agent_id: &str,
            _project_root: &str,
            _request: &AgentResumeRequest,
        ) -> Result<Vec<String>, String> {
            (self.action)();
            Ok(vec!["fake-agent".to_string()])
        }
    }

    fn registry_in(dir: &Path) -> Registry {
        Registry::new(dir.join("daemon.sock"), dir.to_path_buf(), PathBuf::new())
    }

    fn publish_snapshot(registry: &Registry, project_path: &str, tabs: &[&str]) {
        let snapshot = WorkspaceSnapshot {
            projects: vec![Project {
                id: "project-1".to_string(),
                name: "sandbox".to_string(),
                path: project_path.to_string(),
                icon_emoji: None,
                order_index: 0,
                created_at: "2026-01-01 00:00:00".to_string(),
                is_git: true,
            }],
            worktrees: vec![Worktree {
                id: "worktree-main".to_string(),
                project_id: "project-1".to_string(),
                parent_id: None,
                branch: "main".to_string(),
                title: None,
                path: project_path.to_string(),
                is_main: true,
                hidden: false,
                created_at: "2026-01-01 00:00:00".to_string(),
            }],
            tabs: tabs
                .iter()
                .map(|id| Tab {
                    id: (*id).to_string(),
                    project_id: "project-1".to_string(),
                    worktree_id: "worktree-main".to_string(),
                    kind: TabKind::Terminal,
                    title: Some("claude".to_string()),
                    url: None,
                    file_path: None,
                    diff_side: None,
                    diff_commit: None,
                    pr_number: None,
                    plugin_id: None,
                    plugin_view_id: None,
                    plugin_payload: None,
                    plugin_dedupe_key: None,
                    whiteboard_id: None,
                    agent_id: Some("pragma.claude-code".to_string()),
                    fanout_id: None,
                    fanout_member_id: None,
                    user_renamed: false,
                    shell: None,
                    order_index: 0,
                    created_at: "2026-01-01 00:00:00".to_string(),
                })
                .collect(),
        };
        registry.publish_workspace(snapshot);
    }

    fn prepare_record(registry: &Registry, tab_id: &str, cwd: &str) -> String {
        registry
            .prepare_invocation(
                tab_id,
                "worktree-main",
                "project-1",
                cwd,
                "pragma.claude-code",
                &["claude".to_string()],
                no_selection(),
                None,
                Vec::new(),
            )
            .expect("prepare")
    }

    /// A record in the exact state a server restart leaves an interrupted run:
    /// started, reconciled to `interrupted`, with a reported conversation.
    fn interrupted_record(registry: &Registry, tab_id: &str, cwd: &str) -> String {
        let run_id = prepare_record(registry, tab_id, cwd);
        assert!(registry.invocations.start(&run_id).expect("start"));
        assert!(registry
            .invocations
            .set_harness_session_id(&run_id, "harness-1")
            .expect("session id"));
        registry
            .invocations
            .reconcile_after_restart()
            .expect("reconcile");
        run_id
    }

    fn record_state(registry: &Registry, run_id: &str) -> InvocationState {
        registry
            .invocations
            .record(run_id)
            .expect("read")
            .expect("exists")
            .state
    }

    fn latest(registry: &Registry, tab_id: &str) -> InvocationRecord {
        registry
            .invocations
            .latest_for_tab("worktree-main", tab_id)
            .expect("read")
            .expect("exists")
    }

    /// Writes an isolated fake `pragma-cli` that records the argv it was
    /// invoked with, so a test can prove the resumed wrapper actually ran
    /// instead of only that a PTY exists.
    fn fake_cli(dir: &Path, marker: &Path) -> PathBuf {
        let marker = marker.to_string_lossy();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-pragma-cli");
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\"; done > \"{marker}.tmp\"\nmv \"{marker}.tmp\" \"{marker}\"\n"
                ),
            )
            .expect("fake cli");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("executable");
            path
        }
        #[cfg(windows)]
        {
            let path = dir.join("fake-pragma-cli.cmd");
            std::fs::write(&path, format!("@echo off\r\n>\"{marker}\" echo %*\r\n"))
                .expect("fake cli");
            path
        }
    }

    /// The argv the fake CLI recorded, one token per element on Unix and a
    /// whitespace-split line on Windows.
    fn recorded_argv(marker: &Path) -> Vec<String> {
        let contents = std::fs::read_to_string(marker).expect("fake cli recorded its argv");
        #[cfg(unix)]
        {
            contents.lines().map(str::to_string).collect()
        }
        #[cfg(windows)]
        {
            contents.split_whitespace().map(str::to_string).collect()
        }
    }

    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "the supervised wrapper never ran: {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_prepared_but_never_started_run_is_not_restored() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);
        registry
            .invocations
            .set_harness_session_id(&run_id, "harness-1")
            .expect("session id");
        registry
            .invocations
            .reconcile_after_restart()
            .expect("reconcile");

        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");

        assert!(!result.restored);
        assert_eq!(resume.calls(), 0, "nothing may resume a never-started run");
        assert_eq!(record_state(&registry, &run_id), InvocationState::Prepared);
    }

    #[test]
    fn a_restore_runs_the_resumed_wrapper_under_a_fresh_execution() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let mut registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["fake-agent", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        let marker = dir.path().join("argv.txt");
        registry.agent_run_binary = fake_cli(dir.path(), &marker).to_string_lossy().into_owned();
        let registry = Arc::new(registry);
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let old_run = interrupted_record(&registry, "tab-1", &cwd);
        let invocation_id = latest(&registry, "tab-1").invocation_id;

        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");

        assert!(result.restored);
        assert_eq!(resume.calls(), 1);
        wait_for_file(&marker);
        let argv = recorded_argv(&marker);
        let run_id_index = argv
            .iter()
            .position(|arg| arg == "--run-id")
            .expect("wrapper names the run");
        let new_run = argv[run_id_index + 1].clone();
        assert_ne!(new_run, old_run, "a resume is a new execution");
        assert_eq!(argv[run_id_index + 2], "--");
        assert_eq!(
            &argv[run_id_index + 3..],
            ["fake-agent", "--resume", "harness-1"],
            "the resume callback's argv is passed through literally"
        );

        let record = latest(&registry, "tab-1");
        assert_eq!(record.invocation_id, invocation_id);
        assert_eq!(record.run_id, new_run);
        assert_eq!(
            record.state,
            InvocationState::Interrupted,
            "not active until the resumed wrapper acknowledges the child"
        );
        assert_eq!(record.harness_session_id.as_deref(), Some("harness-1"));

        registry.handle_start_run(&new_run).expect("start ack");
        assert_eq!(record_state(&registry, &new_run), InvocationState::Active);
        assert!(
            registry.handle_finish_run(&old_run, Some(0), None).is_err(),
            "the stale execution's end report is rejected"
        );
        assert!(
            registry.handle_finish_run(&new_run, Some(0), None).is_ok(),
            "the new execution's end report closes it"
        );
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_second_restore_waits_for_the_winner_instead_of_reporting_false() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = Arc::new(registry_in(dir.path()));
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        *registry.resume_callback.lock().expect("callback") = Arc::new(GatedResume {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        interrupted_record(&registry, "tab-1", &cwd);

        let owner_registry = Arc::clone(&registry);
        let owner = thread::spawn(move || {
            owner_registry
                .handle_restore_agent_session("tab-1", "worktree-main")
                .expect("owner restore")
        });
        // The owner is now inside the resume callback.
        entered.wait();
        let follower_registry = Arc::clone(&registry);
        let follower = thread::spawn(move || {
            follower_registry
                .handle_restore_agent_session("tab-1", "worktree-main")
                .expect("follower restore")
        });
        // Give the follower time to reach the wait before the owner finishes.
        thread::sleep(Duration::from_millis(150));
        release.wait();

        let owner_result = owner.join().expect("owner thread");
        let follower_result = follower.join().expect("follower thread");
        assert!(owner_result.restored);
        assert!(
            follower_result.restored,
            "a caller that lost the race waits for the winner's outcome, never 'nothing to restore'"
        );
        assert!(
            registry.has_live_session("tab-1"),
            "exactly the winner's session exists"
        );
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_missing_callback_leaves_a_recoverable_failure_never_a_fresh_command() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let failing = FakeResume::failing("agent has no launch.resume callback");
        *registry.resume_callback.lock().expect("callback") = failing.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);

        let error = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect_err("an eligible record that cannot resume is an error");

        assert!(
            error.contains("launch.resume"),
            "error names the cause: {error}"
        );
        assert!(!registry.has_live_session("tab-1"));
        let record = latest(&registry, "tab-1");
        assert_eq!(record.state, InvocationState::Failed);
        assert_eq!(
            record.run_id, run_id,
            "a pre-spawn failure keeps the execution id"
        );
        assert_eq!(record.harness_session_id.as_deref(), Some("harness-1"));

        // The failure is recoverable: once the callback works, an explicit
        // retry restores the same conversation under a fresh execution.
        *registry.resume_callback.lock().expect("callback") =
            FakeResume::returning(&["claude", "--resume", "harness-1"]);
        let retry = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("retry");
        assert!(retry.restored);
        assert!(registry.has_live_session("tab-1"));
        assert_ne!(latest(&registry, "tab-1").run_id, run_id);
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_tombstoned_tab_is_never_restored() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        registry.close_tab("tab-1").expect("close tab");

        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");

        assert!(!result.restored);
        assert_eq!(resume.calls(), 0);
        assert_eq!(
            record_state(&registry, &run_id),
            InvocationState::Ended,
            "closing the tab ends the record before its teardown"
        );
    }

    #[test]
    fn a_close_during_the_resume_callback_aborts_before_the_spawn() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = Arc::new(registry_in(dir.path()));
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        let closing = Arc::clone(&registry);
        *registry.resume_callback.lock().expect("callback") = Arc::new(CallbackAction {
            action: Box::new(move || {
                closing.close_tab("tab-1").expect("close mid-callback");
            }),
        });

        let error = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect_err("a closed tab cannot be restored");

        assert!(
            error.contains("closed"),
            "error explains the close: {error}"
        );
        assert!(
            !registry.has_live_session("tab-1"),
            "the restore must not spawn after the close"
        );
        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
    }

    #[test]
    fn a_new_launch_during_the_resume_callback_aborts_before_the_spawn() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = Arc::new(registry_in(dir.path()));
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let old_run = interrupted_record(&registry, "tab-1", &cwd);
        let preparing = Arc::clone(&registry);
        let new_run = Arc::new(Mutex::new(String::new()));
        let captured = Arc::clone(&new_run);
        *registry.resume_callback.lock().expect("callback") = Arc::new(CallbackAction {
            action: Box::new(move || {
                let run = prepare_record(&preparing, "tab-1", "/tmp/project");
                *captured.lock().expect("capture") = run;
            }),
        });

        let error = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect_err("a superseded invocation cannot be restored");

        assert!(
            error.contains("no longer restorable"),
            "error explains the supersede: {error}"
        );
        assert!(
            !registry.has_live_session("tab-1"),
            "the old execution must not spawn over the new launch"
        );
        let new_run = new_run.lock().expect("capture").clone();
        assert_eq!(latest(&registry, "tab-1").run_id, new_run);
        assert_eq!(
            record_state(&registry, &old_run),
            InvocationState::Superseded
        );
    }

    #[test]
    fn a_record_without_a_harness_session_id_is_not_restored() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);
        registry.invocations.start(&run_id).expect("start");
        registry
            .invocations
            .reconcile_after_restart()
            .expect("reconcile");

        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");

        assert!(!result.restored);
        assert_eq!(resume.calls(), 0, "no id means nothing to resume");
    }

    #[test]
    fn the_proactive_pass_restores_open_tabs_and_skips_closed_ones() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-open", "tab-closed"]);
        let open_run = interrupted_record(&registry, "tab-open", &cwd);
        let closed_run = interrupted_record(&registry, "tab-closed", &cwd);
        registry.close_tab("tab-closed").expect("close tab");

        registry.reconcile_invocations();

        assert!(registry.has_live_session("tab-open"));
        assert_eq!(
            latest(&registry, "tab-open").state,
            InvocationState::Interrupted,
            "the restored record waits for the wrapper's start ack"
        );
        assert_ne!(latest(&registry, "tab-open").run_id, open_run);
        assert!(!registry.has_live_session("tab-closed"));
        assert_eq!(
            record_state(&registry, &closed_run),
            InvocationState::Ended,
            "a closed tab is intentionally over and never restarted"
        );
        registry.kill("tab-open").expect("cleanup kill");
    }

    #[test]
    fn an_explicit_kill_suppresses_restoration_before_teardown() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        registry
            .spawn(
                "tab-1".to_string(),
                "worktree-main".to_string(),
                cwd.clone(),
                80,
                24,
                None,
            )
            .expect("spawn a shell for the tab");

        registry.kill("tab-1").expect("kill");

        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");
        assert!(!result.restored);
        assert_eq!(resume.calls(), 0);
    }

    #[test]
    fn a_restore_never_rotates_a_live_wrapper() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["fake-agent"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        interrupted_record(&registry, "tab-1", &cwd);
        registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");
        let live_run = latest(&registry, "tab-1").run_id;
        assert_eq!(resume.calls(), 1);

        // A delayed follower — the coordinator slot is gone, the record is
        // still interrupted because the wrapper has not acked yet — must not
        // rotate the live wrapper's execution id out from under it.
        let result = registry.spawn_resumed_session(
            &latest(&registry, "tab-1"),
            &["fake-agent".to_string()],
            &[],
            false,
        );

        assert!(result.is_ok());
        assert_eq!(
            latest(&registry, "tab-1").run_id,
            live_run,
            "a live wrapper keeps its execution id"
        );
        assert_eq!(resume.calls(), 1, "no second resume was attempted");
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_delayed_completion_journal_aborts_the_restore() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["fake-agent"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        // The wrapper's finish could not reach the host and journaled its exit
        // *after* the startup replay: the restore must apply it before
        // rotating, not resume a run that already ended.
        let journal = crate::invocations::completions_dir(dir.path());
        std::fs::create_dir_all(&journal).expect("journal dir");
        std::fs::write(journal.join(&run_id), "0").expect("journal entry");

        let error = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect_err("an ended execution is not restorable");

        assert!(
            error.contains("no longer restorable"),
            "the delayed completion aborts the restore: {error}"
        );
        assert!(!registry.has_live_session("tab-1"));
        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
    }

    #[test]
    fn preparing_a_closed_tab_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        registry.close_tab("tab-1").expect("close tab");

        let error = registry
            .prepare_invocation(
                "tab-1",
                "worktree-main",
                "project-1",
                &cwd,
                "pragma.claude-code",
                &["claude".to_string()],
                no_selection(),
                None,
                Vec::new(),
            )
            .expect_err("a closed tab cannot get a tracked launch");

        assert!(error.contains("closed"), "error names the close: {error}");
    }

    #[test]
    fn authorizing_a_start_after_close_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);
        // The delayed background spawn's tab was closed before its wrapper ran.
        registry.close_tab("tab-1").expect("close tab");

        let error = registry
            .handle_start_run(&run_id)
            .expect_err("a closed tab's wrapper must not start");

        assert!(error.contains("closed"), "error names the close: {error}");
        assert_eq!(
            record_state(&registry, &run_id),
            InvocationState::Ended,
            "the run never became active"
        );
    }

    #[test]
    fn authorizing_a_start_without_a_live_session_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);

        let error = registry
            .handle_start_run(&run_id)
            .expect_err("a wrapper with no session behind it must not start");

        assert!(error.contains("live session"), "error explains: {error}");
        assert_eq!(record_state(&registry, &run_id), InvocationState::Prepared);
    }

    #[test]
    fn authorizing_a_start_returns_the_default_env_for_empty_references() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);
        registry
            .spawn(
                "tab-1".to_string(),
                "worktree-main".to_string(),
                cwd.clone(),
                80,
                24,
                None,
            )
            .expect("spawn the tab's shell");

        let authorized = registry.handle_start_run(&run_id).expect("authorize");

        assert!(
            authorized.env.is_empty(),
            "empty references are the explicit default provenance, never a re-resolution of the current binding"
        );
        assert_eq!(record_state(&registry, &run_id), InvocationState::Active);
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_command_line_quotes_for_the_session_or_the_resolved_shell() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let shell = pragma_platform::shell::default_shell();
        let config = serde_json::json!({ "terminal": { "shell": shell } });
        std::fs::create_dir_all(dir.path().join(".pragma")).expect("pragma dir");
        std::fs::write(
            dir.path().join(".pragma/config.json"),
            serde_json::to_vec(&config).expect("config json"),
        )
        .expect("config");
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let argv = vec!["claude".to_string(), "a b".to_string()];

        // No session yet: the owning host's terminal config decides, exactly
        // as the spawn would.
        let fallback = registry.command_line_for_tab("tab-1", &cwd, &argv);
        assert_eq!(fallback, crate::registry::agent_command_line(&argv, &shell));

        // With a live session: its own program is authoritative.
        registry
            .spawn(
                "tab-1".to_string(),
                "worktree-main".to_string(),
                cwd.clone(),
                80,
                24,
                None,
            )
            .expect("spawn");
        let program = registry
            .session("tab-1")
            .expect("session")
            .shell_program()
            .to_string();
        assert_eq!(
            registry.command_line_for_tab("tab-1", &cwd, &argv),
            crate::registry::agent_command_line(&argv, &program)
        );
        registry.kill("tab-1").expect("cleanup kill");
    }

    #[test]
    fn a_run_lifecycle_report_for_an_unknown_run_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let registry = registry_in(dir.path());

        assert!(registry.handle_start_run("missing").is_err());
        assert!(registry
            .handle_finish_run("missing", Some(0), None)
            .is_err());
    }

    fn report(
        worktree_id: &str,
        tab_id: &str,
        harness: Option<&str>,
        run_id: Option<&str>,
    ) -> AgentReportPayload {
        AgentReportPayload {
            agent: "claude-code".to_string(),
            worktree_id: worktree_id.to_string(),
            tab_id: tab_id.to_string(),
            status: None,
            session_name: None,
            attention_kind: None,
            command: None,
            question: None,
            options: vec![],
            questions: vec![],
            request_id: None,
            harness_session_id: harness.map(str::to_string),
            agent_run_id: run_id.map(str::to_string),
            clear_harness_session_id: None,
        }
    }

    fn clear_report(worktree_id: &str, tab_id: &str, run_id: Option<&str>) -> AgentReportPayload {
        let mut payload = report(worktree_id, tab_id, None, run_id);
        payload.clear_harness_session_id = Some(true);
        payload
    }

    #[test]
    fn a_clear_leaves_nothing_to_auto_resume() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        let resume = FakeResume::returning(&["claude", "--resume", "harness-1"]);
        *registry.resume_callback.lock().expect("callback") = resume.clone();
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        assert_eq!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .len(),
            1
        );
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");

        registry
            .report_agent(clear_report("worktree-main", "tab-1", Some(&run_id)))
            .expect("clear report");

        // The live event tells subscribers the identity is gone; the stored
        // snapshot does not keep the clear command around.
        let event = rx.recv().expect("clear is broadcast");
        assert!(
            matches!(
                event,
                pragma_protocol::EventFrame::Agent {
                    harness_session_id: None,
                    clear_harness_session_id: Some(true),
                    ..
                }
            ),
            "the clear is relayed to live subscribers"
        );
        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.iter().all(|event| !matches!(
                event,
                pragma_protocol::EventFrame::Agent {
                    clear_harness_session_id: Some(_),
                    ..
                }
            )),
            "the stored snapshot does not replay the clear command"
        );
        assert_eq!(latest(&registry, "tab-1").harness_session_id, None);
        assert!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .is_empty(),
            "a cleared conversation is never auto-resumed"
        );
        let result = registry
            .handle_restore_agent_session("tab-1", "worktree-main")
            .expect("restore");
        assert!(!result.restored);
        assert_eq!(resume.calls(), 0, "the old conversation must not resume");
    }

    #[test]
    fn a_stale_clear_cannot_clear_a_newer_run() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        // A resume rotated the record onto a new execution with a new
        // conversation.
        let invocation_id = latest(&registry, "tab-1").invocation_id;
        assert!(registry
            .invocations
            .rotate_execution(&invocation_id, "new-run")
            .expect("rotate"));
        assert!(registry
            .invocations
            .set_harness_session_id("new-run", "harness-2")
            .expect("session id"));

        registry
            .report_agent(clear_report("worktree-main", "tab-1", Some(&run_id)))
            .expect("stale clear");

        assert_eq!(
            latest(&registry, "tab-1").harness_session_id.as_deref(),
            Some("harness-2"),
            "a stale execution's clear must not touch the newer run"
        );
    }

    #[test]
    fn a_later_status_report_does_not_resurrect_a_cleared_identity() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        let mut running = report("worktree-main", "tab-1", Some("harness-1"), Some(&run_id));
        running.status = Some(AgentStatus::Running);
        registry.report_agent(running).expect("running report");

        registry
            .report_agent(clear_report("worktree-main", "tab-1", Some(&run_id)))
            .expect("clear report");
        // A later status report carries no ids: it must not merge the cleared
        // identity back in.
        let mut status = report("worktree-main", "tab-1", None, Some(&run_id));
        status.status = Some(AgentStatus::Done);
        registry.report_agent(status).expect("status report");

        assert_eq!(latest(&registry, "tab-1").harness_session_id, None);
        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.iter().any(|event| matches!(
                event,
                pragma_protocol::EventFrame::Agent {
                    status: Some(AgentStatus::Done),
                    harness_session_id: None,
                    ..
                }
            )),
            "the snapshot keeps the identity cleared"
        );
    }

    #[test]
    fn a_clear_wins_over_an_id_in_the_same_report() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        let mut payload = report("worktree-main", "tab-1", Some("harness-x"), Some(&run_id));
        payload.clear_harness_session_id = Some(true);

        registry.report_agent(payload).expect("clear report");

        assert_eq!(
            latest(&registry, "tab-1").harness_session_id,
            None,
            "clearing wins over the id in the same report"
        );
    }

    #[test]
    fn a_clear_without_a_run_id_targets_the_tab_record() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);

        registry
            .report_agent(clear_report("worktree-main", "tab-1", None))
            .expect("clear report");

        assert_eq!(latest(&registry, "tab-1").harness_session_id, None);
        assert_eq!(
            record_state(&registry, &run_id),
            InvocationState::Interrupted
        );
    }

    #[test]
    fn a_late_finish_from_a_previous_boot_cannot_end_the_current_execution() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        assert_eq!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .len(),
            1
        );

        // The old wrapper's finish retries reach the restarted server, whose
        // record still carries the same (interrupted) run id. Without the
        // boot binding this would end the record and suppress recovery.
        let error = registry
            .handle_finish_run(&run_id, Some(0), Some("previous-boot"))
            .expect_err("a report authorized by a previous boot is stale");

        assert!(
            error.contains("stale agent run"),
            "the late report is rejected as stale: {error}"
        );
        assert_eq!(
            record_state(&registry, &run_id),
            InvocationState::Interrupted,
            "the record was not touched"
        );
        assert_eq!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .len(),
            1,
            "the legitimate auto-resume is preserved"
        );

        // A report from the authorizing boot still closes the execution.
        let current = registry.plugins().boot_id().to_string();
        registry
            .handle_finish_run(&run_id, Some(0), Some(&current))
            .expect("same-boot finish");
        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
    }

    #[test]
    fn a_finish_without_a_boot_token_keeps_the_legacy_semantics() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);

        registry
            .handle_finish_run(&run_id, Some(0), None)
            .expect("a legacy wrapper has no token");

        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
    }

    #[test]
    fn a_journaled_intentional_exit_still_ends_across_boots() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        // The previous boot's wrapper also journaled an ordinary code exit
        // before its retries: that is cross-boot evidence of an intentional
        // end and must still close the record.
        let journal = crate::invocations::completions_dir(dir.path());
        std::fs::create_dir_all(&journal).expect("journal dir");
        std::fs::write(journal.join(&run_id), "0").expect("journal entry");

        let error = registry
            .handle_finish_run(&run_id, Some(0), Some("previous-boot"))
            .expect_err("the late socket report is stale");
        assert!(error.contains("stale agent run"));

        registry
            .invocations
            .replay_completions(&journal)
            .expect("replay");

        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
    }

    #[test]
    fn a_session_id_report_moves_the_current_record_and_never_a_superseded_one() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);

        registry
            .report_agent(report(
                "worktree-main",
                "tab-1",
                Some("harness-2"),
                Some(&run_id),
            ))
            .expect("report");

        assert_eq!(
            latest(&registry, "tab-1").harness_session_id.as_deref(),
            Some("harness-2")
        );

        // A new launch supersedes the record; a late report for it is stale.
        let replacement = prepare_record(&registry, "tab-1", &cwd);
        assert!(registry.invocations.start(&replacement).expect("start"));
        registry
            .report_agent(report(
                "worktree-main",
                "tab-1",
                Some("harness-stale"),
                Some(&run_id),
            ))
            .expect("stale report is still handled");

        assert_eq!(
            record_state(&registry, &run_id),
            InvocationState::Superseded
        );
        assert_eq!(
            latest(&registry, "tab-1").harness_session_id,
            None,
            "a superseded run cannot steal the session pointer"
        );
    }

    #[test]
    fn a_report_for_a_new_run_never_inherits_the_previous_conversation() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        // The first execution's status entry knows harness-1.
        let mut running = report("worktree-main", "tab-1", Some("harness-1"), Some(&run_id));
        running.status = Some(AgentStatus::Running);
        registry.report_agent(running).expect("running report");

        // A report from a *different* run in the same tab carries no session
        // id yet: the new execution begins unknown, never with the old
        // conversation.
        registry
            .report_agent(report("worktree-main", "tab-1", None, Some("other-run")))
            .expect("report");

        assert_eq!(
            latest(&registry, "tab-1").harness_session_id.as_deref(),
            Some("harness-1"),
            "the store keeps the invocation's last known conversation"
        );
        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.iter().any(|event| matches!(
                event,
                pragma_protocol::EventFrame::Agent {
                    status: Some(AgentStatus::Running),
                    harness_session_id: None,
                    agent_run_id: Some(run_id),
                    ..
                } if run_id == "other-run"
            )),
            "the status payload does not advertise the old conversation for the new run"
        );
    }

    #[test]
    fn an_ids_only_report_is_stored_but_not_broadcast() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = prepare_record(&registry, "tab-1", &cwd);
        assert!(registry.invocations.start(&run_id).expect("start"));
        // Subscribe first: the broadcast is live-only, so a late subscriber
        // would never see it.
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");
        let mut running = report("worktree-main", "tab-1", None, None);
        running.status = Some(AgentStatus::Attention);
        running.attention_kind = Some(pragma_constants::AgentAttentionKind::Question);
        running.question = Some("Which database?".to_string());
        running.request_id = Some("req-1".to_string());
        registry.report_agent(running).expect("attention report");
        assert!(rx.recv().is_ok(), "the attention report was broadcast");

        registry
            .report_agent(report(
                "worktree-main",
                "tab-1",
                Some("harness-1"),
                Some(&run_id),
            ))
            .expect("ids-only report");

        assert!(
            rx.try_recv().is_err(),
            "an ids-only update has nothing observable to broadcast"
        );
        assert_eq!(
            latest(&registry, "tab-1").harness_session_id.as_deref(),
            Some("harness-1")
        );
        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.iter().any(|event| matches!(
                event,
                pragma_protocol::EventFrame::Agent {
                    status: Some(AgentStatus::Attention),
                    harness_session_id: Some(id),
                    question: Some(question),
                    request_id: Some(request_id),
                    ..
                } if id == "harness-1"
                    && question == "Which database?"
                    && request_id == "req-1"
            )),
            "the stored snapshot carries the ids and keeps the pending attention payload"
        );
    }

    #[test]
    fn selection_parses_an_empty_object_and_rejects_malformed_values() {
        assert!(selection_from_value(None).expect("none").model_id.is_none());
        assert!(selection_from_value(Some(&Value::Null))
            .expect("null")
            .model_id
            .is_none());
        assert!(selection_from_value(Some(&serde_json::json!({})))
            .expect("empty")
            .model_id
            .is_none());
        let parsed = selection_from_value(Some(&serde_json::json!({
            "modelId": "sonnet",
            "reasoningId": null,
        })))
        .expect("valid");
        assert_eq!(parsed.model_id.as_deref(), Some("sonnet"));
        assert!(parsed.reasoning_id.is_none());
        assert!(selection_from_value(Some(&serde_json::json!({ "modelId": 7 }))).is_err());
        assert!(
            selection_from_value(Some(&serde_json::json!("sonnet"))).is_err(),
            "a non-object selection is malformed, not an empty choice"
        );
    }

    #[test]
    fn registry_startup_replays_completions_before_reconciliation() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        // A previous server left an active record and a journaled completion:
        // the wrapper exited while the host was restarting.
        {
            let store = InvocationStore::open(&invocations_path(dir.path())).expect("store");
            let prepared = store
                .prepare(&NewInvocation {
                    tab_id: "tab-1".to_string(),
                    worktree_id: "worktree-main".to_string(),
                    project_id: Some("project-1".to_string()),
                    agent_id: "pragma.claude-code".to_string(),
                    cwd: cwd.clone(),
                    shell: None,
                    command: vec!["claude".to_string()],
                    selection: no_selection(),
                    accounts: Vec::new(),
                })
                .expect("prepare");
            store.start(&prepared.run_id).expect("start");
            store
                .set_harness_session_id(&prepared.run_id, "harness-1")
                .expect("session id");
            let journal = completions_dir(dir.path());
            std::fs::create_dir_all(&journal).expect("journal dir");
            std::fs::write(journal.join(&prepared.run_id), "0").expect("journal entry");
        }

        let registry = registry_in(dir.path());

        assert!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .is_empty(),
            "a journaled intentional exit is never reconciled into interrupted"
        );
    }

    #[test]
    fn an_unopenable_store_keeps_the_host_up_but_fails_preparation() {
        let dir = tempdir().expect("tempdir");
        // Occupy the store path so SQLite cannot open it.
        std::fs::create_dir_all(invocations_path(dir.path())).expect("occupy store path");
        let registry = registry_in(dir.path());

        assert!(!registry.invocations.is_available());
        let error = registry
            .prepare_invocation(
                "tab-1",
                "worktree-main",
                "project-1",
                "/tmp/project",
                "pragma.claude-code",
                &["claude".to_string()],
                no_selection(),
                None,
                Vec::new(),
            )
            .expect_err("preparation must fail without a durable store");
        assert!(
            error.contains("unavailable"),
            "the storage cause is surfaced: {error}"
        );
    }

    #[test]
    fn completion_journal_replay_happens_before_reconciliation() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let registry = registry_in(dir.path());
        publish_snapshot(&registry, &cwd, &["tab-1"]);
        let run_id = interrupted_record(&registry, "tab-1", &cwd);
        // A wrapper that could not reach the server after its child exited.
        let journal = crate::invocations::completions_dir(dir.path());
        std::fs::create_dir_all(&journal).expect("journal dir");
        std::fs::write(journal.join(&run_id), "0").expect("journal entry");

        // A restart replays the journal before reconciling: the intentional
        // exit must not become "interrupted".
        registry
            .invocations
            .replay_completions(&journal)
            .expect("replay");
        registry
            .invocations
            .reconcile_after_restart()
            .expect("reconcile");

        assert_eq!(record_state(&registry, &run_id), InvocationState::Ended);
        assert_eq!(
            registry
                .invocations
                .interrupted_and_resumable()
                .expect("eligible")
                .len(),
            0,
            "an intentional exit is never resurrected"
        );
    }
}
