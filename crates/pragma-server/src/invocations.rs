//! Durable record of prepared agent invocations.
//!
//! A launch the desktop prepares through `prepareAgentLaunch` — and every
//! server-owned (headless) launch of an agent whose plugin opted into resume —
//! is recorded here before it starts, so a crash or a native-update quit can
//! bring the exact harness conversation back. The record lives in a `SQLite`
//! database beside the server socket (per channel, like every other
//! host-owned store), in transactions, owner-only.
//!
//! # Identity: one invocation, many executions
//!
//! A tab's *invocation* is the durable conversation context: agent, cwd,
//! shell, selection, account references, and the latest harness session id.
//! Each time the agent is actually launched — the original launch, then every
//! resume — is a separate *execution* with its own run id. Only the current
//! execution's id is in the record, so a stale wrapper's `finishRun` (or a
//! late report) can neither end nor re-point a newer execution: it simply
//! names an id no row carries any more.
//!
//! ```text
//! prepare ──► Prepared ──start──► Active ──finish──► Ended
//!                 │                 │
//!                 │                 └─ server restart ─► Interrupted ─┐
//!                 │                                     │            │
//!                 │                    restore (new run id)          │
//!                 │                                     ▼            │
//!                 │                              Interrupted ──start──► Active
//!                 ├──────────superseded by a new launch──► Superseded
//!                 └──────────────────────────────────────────► Failed
//! ```
//!
//! - Only `Active → Interrupted` (a process that had actually started and then
//!   lost its server) is automatically restorable. A record still `Prepared`
//!   when the server restarts never ran a child, so it is never restored.
//! - A record with no harness session id has nothing to resume and is never
//!   restored, whatever its state.
//! - A restore rotates the execution id and leaves the record `Interrupted`
//!   until the resumed wrapper's `startRun` acknowledges that the child really
//!   started.
//! - `Ended` is the only state a running child's own exit produces. A cleared
//!   agent status or a watcher exiting is **not** an end signal.
//! - `Superseded` is terminal: a newer launch for the same tab retired the
//!   record, and a replayed `startRun`/`finishRun` for it is stale.
//! - `Failed` keeps every field it had — the harness id and the launch
//!   selection included — so an explicit retry can still resume it.
//!
//! # Completion journal
//!
//! A wrapper that cannot reach the server after its child exited writes a
//! completion journal entry beside the socket (`agent-completions/<run-id>`)
//! before it exits. [`InvocationStore::replay_completions`] applies those
//! before the startup reconciliation marks anything interrupted, so an
//! intentional exit is never mistaken for a crash.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use pragma_constants::{AccountSessionUse, AgentLaunchSelection, ShellProfile};
use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

/// File beside `daemon.sock` holding agent invocations. Channel separation
/// comes from the server directory itself: each dev worktree and the
/// production install resolve their own state dir.
const INVOCATIONS_FILE: &str = "agent-invocations.db";

/// Directory beside the socket where `pragma-cli agent run` drops completion
/// entries it could not deliver over the socket. The CLI mirrors this name
/// (`crates/pragma-cli/src/agent_run.rs`); there is no shared crate that both
/// can depend on, so the two constants are pinned by tests on each side.
pub const COMPLETIONS_DIR: &str = "agent-completions";

/// How long a lock is retried before an operation fails. The store is touched
/// on report/launch/restore paths; a concurrent access is expected, a wedged
/// one is not.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a terminal (ended/superseded) record is kept for diagnostics.
/// Live and interrupted records are never pruned: they are the resume state.
const HISTORY_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Schema version of the store. 0 is the pre-invocation-id shape; 1 is the
/// current one. Bump when the table shape changes.
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum InvocationError {
    #[error("invocation store: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invocation store io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invocation store lock poisoned")]
    LockPoisoned,
    #[error("invocation record is corrupt: {0}")]
    Corrupt(String),
    /// The store could not be opened. The host keeps running (every other
    /// subsystem works), but preparation and restoration must fail loudly
    /// rather than pretend a durable record exists.
    #[error("invocation store unavailable: {0}")]
    Unavailable(String),
}

/// Where one invocation is in its life. See the module docs for the rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationState {
    /// Recorded, command handed back to the caller, child not started yet.
    Prepared,
    /// The supervisor reported the child started.
    Active,
    /// The server that owned it stopped while it was active, or a restore is
    /// in flight. Automatically eligible for restore once a harness session id
    /// is known.
    Interrupted,
    /// The supervised child exited. Terminal; never restored.
    Ended,
    /// A newer launch for the same tab retired this record. Terminal; stale
    /// reports for it are rejected.
    Superseded,
    /// A restore attempt could not complete. Kept recoverable: an explicit
    /// restore can retry it, and it is never replaced with a fresh command.
    Failed,
}

impl InvocationState {
    fn parse(value: &str) -> Result<Self, InvocationError> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "active" => Ok(Self::Active),
            "interrupted" => Ok(Self::Interrupted),
            "ended" => Ok(Self::Ended),
            "superseded" => Ok(Self::Superseded),
            "failed" => Ok(Self::Failed),
            other => Err(InvocationError::Corrupt(format!("unknown state `{other}`"))),
        }
    }
}

/// One recorded invocation, as persisted. `run_id` is the *current*
/// execution's id; `invocation_id` stays with the conversation context across
/// resumes.
#[derive(Debug, Clone, PartialEq)]
pub struct InvocationRecord {
    pub invocation_id: String,
    /// The current execution's run id (the id a wrapper carries).
    pub run_id: String,
    /// Insertion order, monotonic across the store. The only ordering key:
    /// `updated_at` has second precision, so two launches in one second would
    /// otherwise tie and a random run id would decide which is "current".
    pub seq: i64,
    pub tab_id: String,
    pub worktree_id: String,
    /// Project the launch resolved against, for catalog lookups on restore.
    pub project_id: Option<String>,
    pub agent_id: String,
    /// Absolute checkout path the session runs in.
    pub cwd: String,
    /// The shell the tab was opened with, so a restore returns to it rather
    /// than the current default. `None` re-resolves at spawn time, exactly
    /// like the original desktop spawn.
    pub shell: Option<ShellProfile>,
    /// The literal agent argv the caller supplied, before wrapping.
    pub command: Vec<String>,
    /// Launch-time choices, with the effective mode and permission mode filled
    /// in so a future default change cannot alter a resume.
    pub selection: AgentLaunchSelection,
    /// Effective account references (provider + account key) the launch used,
    /// so a resume returns to the same logins. References, never credentials.
    pub accounts: Vec<AccountSessionUse>,
    pub state: InvocationState,
    /// The harness's own conversation id, as last reported. Opaque.
    pub harness_session_id: Option<String>,
    /// Why a restore failed, when `state` is `Failed`.
    pub failure: Option<String>,
    /// Exit code of the supervised child, once reported.
    pub exit_code: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl InvocationRecord {
    /// Automatically restorable: the child was actually running when its
    /// server went away, and there is a conversation to resume.
    #[must_use]
    #[cfg(test)]
    pub fn is_auto_restorable(&self) -> bool {
        self.state == InvocationState::Interrupted && self.harness_session_id.is_some()
    }

    /// Explicitly restorable: interrupted, or a failed attempt that kept its
    /// harness id. `Prepared` (never started) and `Ended`/`Superseded` never
    /// qualify.
    #[must_use]
    pub fn is_explicitly_restorable(&self) -> bool {
        matches!(
            self.state,
            InvocationState::Interrupted | InvocationState::Failed
        ) && self.harness_session_id.is_some()
    }
}

/// Everything `prepare` needs from the caller; ids, ordering, state, and
/// timestamps are the store's own.
pub struct NewInvocation {
    pub tab_id: String,
    pub worktree_id: String,
    pub project_id: Option<String>,
    pub agent_id: String,
    pub cwd: String,
    pub shell: Option<ShellProfile>,
    pub command: Vec<String>,
    pub selection: AgentLaunchSelection,
    pub accounts: Vec<AccountSessionUse>,
}

/// The ids a prepared launch hands back: the stable invocation and the
/// execution the wrapper must carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedInvocation {
    pub invocation_id: String,
    pub run_id: String,
}

enum Store {
    Ready(Mutex<Connection>),
    Unavailable(String),
}

/// The durable invocation store.
pub struct InvocationStore {
    store: Store,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The directory completion journal entries are dropped in.
#[must_use]
pub fn completions_dir(server_dir: &Path) -> PathBuf {
    server_dir.join(COMPLETIONS_DIR)
}

impl InvocationStore {
    /// Opens (creating or migrating if needed) the store beside the socket.
    /// The database file is created owner-only before `SQLite` ever sees it,
    /// and the `SQLite` sidecar files are re-restricted because `SQLite` creates
    /// them itself.
    pub fn open(path: &Path) -> Result<Self, InvocationError> {
        if !path.exists() {
            pragma_platform::perms::create_private_file(path)?;
        }
        let connection = Connection::open(path)?;
        pragma_platform::perms::restrict_to_owner(path)?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        migrate(&connection)?;
        restrict_sidecar_files(path);
        Ok(Self {
            store: Store::Ready(Mutex::new(connection)),
        })
    }

    /// A store whose database could not be opened. Every operation returns
    /// [`InvocationError::Unavailable`] with the original cause, so the host
    /// stays up while preparation and restoration fail with a reason instead
    /// of silently claiming durable tracking they do not have.
    #[must_use]
    pub fn unavailable(cause: impl Into<String>) -> Self {
        Self {
            store: Store::Unavailable(cause.into()),
        }
    }

    /// True when the durable database is actually open.
    #[must_use]
    #[cfg(test)]
    pub fn is_available(&self) -> bool {
        matches!(self.store, Store::Ready(_))
    }

    /// Opens an in-memory store for tests and host-free rule checks.
    #[cfg(test)]
    fn in_memory() -> Result<Self, InvocationError> {
        let connection = Connection::open_in_memory()?;
        create_schema(&connection)?;
        Ok(Self {
            store: Store::Ready(Mutex::new(connection)),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, InvocationError> {
        match &self.store {
            Store::Ready(connection) => {
                connection.lock().map_err(|_| InvocationError::LockPoisoned)
            }
            Store::Unavailable(cause) => Err(InvocationError::Unavailable(cause.clone())),
        }
    }

    /// Records a new launch, retiring any earlier live record for the same tab
    /// so its conversation can never win a later restore.
    pub fn prepare(&self, new: &NewInvocation) -> Result<PreparedInvocation, InvocationError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        // Finished history is only diagnostic; keep it bounded so a long-lived
        // host does not accumulate one row per launch forever.
        transaction.execute(
            "DELETE FROM agent_invocations
              WHERE state IN ('ended', 'superseded')
                AND updated_at < ?1",
            params![now() - HISTORY_RETENTION_SECONDS],
        )?;
        transaction.execute(
            "UPDATE agent_invocations
                SET state = 'superseded', updated_at = ?2
              WHERE tab_id = ?1
                AND state IN ('prepared', 'active', 'interrupted', 'failed')",
            params![new.tab_id, now()],
        )?;
        let seq: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_invocations",
            [],
            |row| row.get(0),
        )?;
        let invocation_id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let command = serde_json::to_string(&new.command)
            .map_err(|error| InvocationError::Corrupt(error.to_string()))?;
        let selection = serde_json::to_string(&new.selection)
            .map_err(|error| InvocationError::Corrupt(error.to_string()))?;
        let accounts = serde_json::to_string(&new.accounts)
            .map_err(|error| InvocationError::Corrupt(error.to_string()))?;
        let shell = new
            .shell
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| InvocationError::Corrupt(error.to_string()))?;
        let timestamp = now();
        transaction.execute(
            "INSERT INTO agent_invocations (
               invocation_id, run_id, seq, tab_id, worktree_id, project_id,
               agent_id, cwd, shell, command, selection, accounts, state,
               harness_session_id, failure, exit_code, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       'prepared', NULL, NULL, NULL, ?13, ?13)",
            params![
                invocation_id,
                run_id,
                seq,
                new.tab_id,
                new.worktree_id,
                new.project_id,
                new.agent_id,
                new.cwd,
                shell,
                command,
                selection,
                accounts,
                timestamp,
            ],
        )?;
        transaction.commit()?;
        Ok(PreparedInvocation {
            invocation_id,
            run_id,
        })
    }

    /// Marks the supervised child started. Returns `false` for a stale report
    /// (unknown, ended, or superseded execution), which must not revive it.
    pub fn start(&self, run_id: &str) -> Result<bool, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET state = 'active', failure = NULL, updated_at = ?2
              WHERE run_id = ?1
                AND state IN ('prepared', 'active', 'interrupted', 'failed')",
            params![run_id, now()],
        )?;
        Ok(updated == 1)
    }

    /// Marks the supervised child exited. Idempotent for an already-ended
    /// execution; an unknown or superseded one is rejected as stale.
    pub fn finish(&self, run_id: &str, exit_code: Option<i32>) -> Result<bool, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET state = 'ended', exit_code = COALESCE(?2, exit_code), updated_at = ?3
              WHERE run_id = ?1
                AND state IN ('prepared', 'active', 'interrupted', 'failed', 'ended')",
            params![run_id, exit_code, now()],
        )?;
        if updated == 1 {
            return Ok(true);
        }
        // Distinguish "already ended" (accepted) from "stale" (rejected).
        let state: Option<String> = connection
            .query_row(
                "SELECT state FROM agent_invocations WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(state.as_deref() == Some("ended"))
    }

    /// Points the invocation at the harness conversation most recently
    /// reported. Returns `false` when the execution is unknown or superseded (a
    /// stale report that must not steal the pointer).
    pub fn set_harness_session_id(
        &self,
        run_id: &str,
        harness_session_id: &str,
    ) -> Result<bool, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET harness_session_id = ?2, updated_at = ?3
              WHERE run_id = ?1 AND state != 'superseded'",
            params![run_id, harness_session_id, now()],
        )?;
        Ok(updated == 1)
    }

    /// Clears the harness conversation the current execution points at, so
    /// nothing resumes it. Returns `false` for an unknown or superseded
    /// execution: a stale clear must never touch a newer run's conversation.
    pub fn clear_harness_session_id(&self, run_id: &str) -> Result<bool, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET harness_session_id = NULL, updated_at = ?2
              WHERE run_id = ?1 AND state != 'superseded'",
            params![run_id, now()],
        )?;
        Ok(updated == 1)
    }

    /// Applies a clear that carried no run id (an older reporter, or an agent
    /// started outside Pragma) to the tab's newest live record.
    pub fn clear_harness_session_id_for_tab(
        &self,
        worktree_id: &str,
        tab_id: &str,
    ) -> Result<bool, InvocationError> {
        let Some(record) = self.latest_for_tab(worktree_id, tab_id)? else {
            return Ok(false);
        };
        if record.state == InvocationState::Superseded {
            return Ok(false);
        }
        self.clear_harness_session_id(&record.run_id)
    }

    /// Applies a status-less session-id report that carried no run id (an
    /// older reporter, or a run launched outside Pragma) to the tab's newest
    /// live record, when one exists.
    pub fn set_harness_session_id_for_tab(
        &self,
        worktree_id: &str,
        tab_id: &str,
        harness_session_id: &str,
    ) -> Result<bool, InvocationError> {
        let Some(record) = self.latest_for_tab(worktree_id, tab_id)? else {
            return Ok(false);
        };
        if record.state == InvocationState::Superseded {
            return Ok(false);
        }
        self.set_harness_session_id(&record.run_id, harness_session_id)
    }

    /// Rotates the record onto a fresh execution id for a resume, leaving it
    /// `interrupted` until the resumed wrapper's `startRun` acknowledges the
    /// child. Only an interrupted or failed record can be resumed; an ended or
    /// superseded one returns `false`.
    pub fn rotate_execution(
        &self,
        invocation_id: &str,
        new_run_id: &str,
    ) -> Result<bool, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET run_id = ?2, state = 'interrupted', failure = NULL,
                    exit_code = NULL, updated_at = ?3
              WHERE invocation_id = ?1 AND state IN ('interrupted', 'failed')",
            params![invocation_id, new_run_id, now()],
        )?;
        Ok(updated == 1)
    }

    /// Startup reconciliation: anything the previous process left `Active` was
    /// interrupted by definition. `Prepared` records are left alone — they may
    /// be a desktop command about to be typed — but never restore.
    pub fn reconcile_after_restart(&self) -> Result<usize, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET state = 'interrupted', updated_at = ?1
              WHERE state = 'active'",
            params![now()],
        )?;
        Ok(updated)
    }

    /// Marks a restore attempt failed, keeping the record (and its harness id)
    /// so an explicit retry can pick it up again. Conditional on the live
    /// states: a failure racing a close must not turn an ended record back
    /// into a recoverable one.
    pub fn fail(&self, run_id: &str, reason: &str) -> Result<(), InvocationError> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE agent_invocations
                SET state = 'failed', failure = ?2, updated_at = ?3
              WHERE run_id = ?1
                AND state IN ('prepared', 'active', 'interrupted', 'failed')",
            params![run_id, reason, now()],
        )?;
        Ok(())
    }

    /// Ends every live record for a tab whose session is being torn down — an
    /// explicit close, a kill, or the shell exiting on its own. Whatever the
    /// reason, a tab without a session is intentionally exited-to-shell and
    /// must never be restored.
    pub fn end_for_tab(&self, tab_id: &str) -> Result<usize, InvocationError> {
        let connection = self.lock()?;
        let updated = connection.execute(
            "UPDATE agent_invocations
                SET state = 'ended', updated_at = ?2
              WHERE tab_id = ?1
                AND state IN ('prepared', 'active', 'interrupted', 'failed')",
            params![tab_id, now()],
        )?;
        Ok(updated)
    }

    /// Applies completion journal entries a wrapper could not deliver over the
    /// socket, then removes them. Runs **before** startup reconciliation: an
    /// intentional exit recorded here must not be marked interrupted.
    ///
    /// An entry for an execution the record no longer carries (a stale wrapper
    /// finishing after a resume) is dropped without touching the record.
    pub fn replay_completions(&self, dir: &Path) -> Result<usize, InvocationError> {
        if !dir.is_dir() {
            return Ok(0);
        }
        let mut applied = 0;
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(run_id) = entry.file_name().to_str().map(str::to_string) else {
                let _ = std::fs::remove_file(entry.path());
                continue;
            };
            let exit_code = std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|contents| contents.trim().parse::<i32>().ok());
            match self.finish(&run_id, exit_code) {
                Ok(true) => applied += 1,
                Ok(false) => {}
                Err(error) => {
                    // Leave the entry for the next start rather than losing a
                    // real completion because the database hiccuped.
                    eprintln!("agent invocations: completion replay failed: {error}");
                    continue;
                }
            }
            let _ = std::fs::remove_file(entry.path());
        }
        Ok(applied)
    }

    /// The record for an execution id, or `None` when unknown.
    pub fn record(&self, run_id: &str) -> Result<Option<InvocationRecord>, InvocationError> {
        let connection = self.lock()?;
        connection
            .query_row(
                &format!("SELECT {RECORD_COLUMNS} FROM agent_invocations WHERE run_id = ?1"),
                params![run_id],
                record_from_row,
            )
            .optional()
            .map_err(InvocationError::from)
    }

    /// The newest record for a tab, live or recently ended, by insertion order.
    pub fn latest_for_tab(
        &self,
        worktree_id: &str,
        tab_id: &str,
    ) -> Result<Option<InvocationRecord>, InvocationError> {
        let connection = self.lock()?;
        connection
            .query_row(
                &format!(
                    "SELECT {RECORD_COLUMNS} FROM agent_invocations
                      WHERE worktree_id = ?1 AND tab_id = ?2
                      ORDER BY seq DESC LIMIT 1"
                ),
                params![worktree_id, tab_id],
                record_from_row,
            )
            .optional()
            .map_err(InvocationError::from)
    }

    /// Every interrupted record with a known harness conversation, in launch
    /// order, for the proactive restore pass.
    pub fn interrupted_and_resumable(&self) -> Result<Vec<InvocationRecord>, InvocationError> {
        self.by_states("state = 'interrupted' AND harness_session_id IS NOT NULL")
    }

    /// The most recent explicitly restorable record for a tab: interrupted, or
    /// a failed attempt that kept its harness id.
    pub fn resumable_for_tab(
        &self,
        worktree_id: &str,
        tab_id: &str,
    ) -> Result<Option<InvocationRecord>, InvocationError> {
        let Some(record) = self.latest_for_tab(worktree_id, tab_id)? else {
            return Ok(None);
        };
        Ok(record.is_explicitly_restorable().then_some(record))
    }

    fn by_states(&self, predicate: &str) -> Result<Vec<InvocationRecord>, InvocationError> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT {RECORD_COLUMNS} FROM agent_invocations
              WHERE {predicate}
              ORDER BY seq ASC"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map([], record_from_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }
}

const RECORD_COLUMNS: &str = "invocation_id, run_id, seq, tab_id, worktree_id, project_id,
    agent_id, cwd, shell, command, selection, accounts, state,
    harness_session_id, failure, exit_code, created_at, updated_at";

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InvocationRecord> {
    let state: String = row.get(12)?;
    let shell: Option<String> = row.get(8)?;
    let command: String = row.get(9)?;
    let selection: String = row.get(10)?;
    let accounts: String = row.get(11)?;
    let corrupt = |error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    };
    Ok(InvocationRecord {
        invocation_id: row.get(0)?,
        run_id: row.get(1)?,
        seq: row.get(2)?,
        tab_id: row.get(3)?,
        worktree_id: row.get(4)?,
        project_id: row.get(5)?,
        agent_id: row.get(6)?,
        cwd: row.get(7)?,
        shell: shell
            .map(|value| serde_json::from_str(&value).map_err(|error| corrupt(error.to_string())))
            .transpose()?,
        command: serde_json::from_str(&command).map_err(|error| corrupt(error.to_string()))?,
        selection: serde_json::from_str(&selection).map_err(|error| corrupt(error.to_string()))?,
        accounts: serde_json::from_str(&accounts).map_err(|error| corrupt(error.to_string()))?,
        state: InvocationState::parse(&state).map_err(|error| corrupt(error.to_string()))?,
        harness_session_id: row.get(13)?,
        failure: row.get(14)?,
        exit_code: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

/// Creates the current schema on an empty database.
fn create_schema(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_invocations (
           invocation_id TEXT PRIMARY KEY,
           run_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           tab_id TEXT NOT NULL,
           worktree_id TEXT NOT NULL,
           project_id TEXT,
           agent_id TEXT NOT NULL,
           cwd TEXT NOT NULL,
           shell TEXT,
           command TEXT NOT NULL,
           selection TEXT NOT NULL,
           accounts TEXT NOT NULL,
           state TEXT NOT NULL,
           harness_session_id TEXT,
           failure TEXT,
           exit_code INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS agent_invocations_run
           ON agent_invocations(run_id);
         CREATE INDEX IF NOT EXISTS agent_invocations_tab
           ON agent_invocations(tab_id, seq DESC);",
    )
}

/// Brings any existing database to [`SCHEMA_VERSION`].
///
/// The pre-versioning shape keyed rows by `run_id` and had no ordering column;
/// the migration preserves every record (its run id becomes both the
/// invocation and its current execution) and backfills `seq` from the implicit
/// rowid, which is the same insertion order.
fn migrate(connection: &Connection) -> Result<(), InvocationError> {
    connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let has_table: bool = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_invocations'",
        [],
        |row| row.get::<_, i64>(0).map(|count| count > 0),
    )?;
    if !has_table {
        create_schema(connection)?;
        connection.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        return Ok(());
    }
    let has_invocation_id: bool = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('agent_invocations')
          WHERE name = 'invocation_id'",
        [],
        |row| row.get::<_, i64>(0).map(|count| count > 0),
    )?;
    if version >= SCHEMA_VERSION && has_invocation_id {
        create_schema(connection)?;
        return Ok(());
    }
    // v0 → v1 rebuild. One transaction: a crash mid-migration leaves the old
    // shape intact, and the retry starts over.
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        "ALTER TABLE agent_invocations RENAME TO agent_invocations_v0;
         CREATE TABLE agent_invocations (
           invocation_id TEXT PRIMARY KEY,
           run_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           tab_id TEXT NOT NULL,
           worktree_id TEXT NOT NULL,
           project_id TEXT,
           agent_id TEXT NOT NULL,
           cwd TEXT NOT NULL,
           shell TEXT,
           command TEXT NOT NULL,
           selection TEXT NOT NULL,
           accounts TEXT NOT NULL,
           state TEXT NOT NULL,
           harness_session_id TEXT,
           failure TEXT,
           exit_code INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         INSERT INTO agent_invocations (
           invocation_id, run_id, seq, tab_id, worktree_id, project_id,
           agent_id, cwd, shell, command, selection, accounts, state,
           harness_session_id, failure, exit_code, created_at, updated_at
         )
         SELECT run_id, run_id, rowid, tab_id, worktree_id, project_id,
                agent_id, cwd, shell, command, selection, '[]', state,
                harness_session_id, failure, exit_code, created_at, updated_at
           FROM agent_invocations_v0;
         DROP TABLE agent_invocations_v0;",
    )?;
    transaction.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    transaction.commit()?;
    create_schema(connection)?;
    Ok(())
}

/// Re-restricts the WAL/SHM sidecars `SQLite` creates on its own.
fn restrict_sidecar_files(database: &Path) {
    for suffix in ["-wal", "-shm"] {
        let candidate = format!("{}{suffix}", database.to_string_lossy());
        let path = Path::new(candidate.as_str());
        if path.exists() {
            let _ = pragma_platform::perms::restrict_to_owner(path);
        }
    }
}

/// The path of the invocation store beside the socket.
#[must_use]
pub fn invocations_path(server_dir: &Path) -> PathBuf {
    server_dir.join(INVOCATIONS_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> InvocationStore {
        InvocationStore::in_memory().expect("in-memory store")
    }

    fn new(tab_id: &str) -> NewInvocation {
        NewInvocation {
            tab_id: tab_id.to_string(),
            worktree_id: format!("w-{tab_id}"),
            project_id: Some("p1".to_string()),
            agent_id: "pragma.claude-code".to_string(),
            cwd: "/tmp/project".to_string(),
            shell: None,
            command: vec!["claude".to_string()],
            selection: AgentLaunchSelection {
                model_id: None,
                reasoning_id: None,
                mode_id: None,
                permission_mode_id: None,
                slash_command: None,
            },
            accounts: Vec::new(),
        }
    }

    fn prepare(store: &InvocationStore, tab_id: &str) -> PreparedInvocation {
        store.prepare(&new(tab_id)).expect("prepare")
    }

    #[test]
    fn prepared_record_is_not_restorable_even_after_a_restart() {
        let store = store();
        let prepared = prepare(&store, "t1");

        store.reconcile_after_restart().expect("reconcile");

        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.state, InvocationState::Prepared);
        assert!(!record.is_auto_restorable());
        assert!(!record.is_explicitly_restorable());
    }

    #[test]
    fn active_record_becomes_interrupted_and_is_restorable_only_with_a_session_id() {
        let store = store();
        let prepared = prepare(&store, "t1");
        assert!(store.start(&prepared.run_id).expect("start"));

        store.reconcile_after_restart().expect("reconcile");
        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.state, InvocationState::Interrupted);
        assert!(
            !record.is_auto_restorable(),
            "no harness session id means nothing to resume"
        );

        assert!(store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id"));
        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert!(record.is_auto_restorable());
    }

    #[test]
    fn finished_record_is_never_restored() {
        let store = store();
        let prepared = prepare(&store, "t1");
        assert!(store.start(&prepared.run_id).expect("start"));
        assert!(store.finish(&prepared.run_id, Some(0)).expect("finish"));
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");

        store.reconcile_after_restart().expect("reconcile");

        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.state, InvocationState::Ended);
        assert!(!record.is_auto_restorable());
        assert!(!record.is_explicitly_restorable());
    }

    #[test]
    fn finish_is_idempotent_and_an_ended_record_stays_ended() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        assert!(store.finish(&prepared.run_id, None).expect("first finish"));
        assert!(
            store.finish(&prepared.run_id, None).expect("repeat finish"),
            "a repeated end report is not an error"
        );

        // A later launch for the same tab does not resurrect a finished run.
        let replacement = prepare(&store, "t1");
        let ended = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(ended.state, InvocationState::Ended);
        assert!(
            !store.start(&prepared.run_id).expect("stale start"),
            "an ended run cannot be revived"
        );
        let current = store
            .record(&replacement.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(current.state, InvocationState::Prepared);
    }

    #[test]
    fn a_new_launch_supersedes_a_live_record_for_the_same_tab() {
        let store = store();
        let first = prepare(&store, "t1");
        store.start(&first.run_id).expect("start");
        store
            .set_harness_session_id(&first.run_id, "harness-1")
            .expect("session id");

        let second = prepare(&store, "t1");

        let old = store.record(&first.run_id).expect("read").expect("exists");
        assert_eq!(old.state, InvocationState::Superseded);
        assert!(!old.is_auto_restorable());
        assert!(
            !store.start(&first.run_id).expect("stale start"),
            "a superseded run cannot be revived"
        );
        assert!(
            !store.finish(&first.run_id, None).expect("stale finish"),
            "a superseded run's end report is stale"
        );
        assert!(
            !store
                .set_harness_session_id(&first.run_id, "late")
                .expect("stale id"),
            "a superseded run cannot steal the session pointer"
        );
        let current = store.record(&second.run_id).expect("read").expect("exists");
        assert_eq!(current.state, InvocationState::Prepared);
    }

    #[test]
    fn latest_for_tab_follows_launch_order_not_timestamps_or_run_ids() {
        let store = store();
        // Two launches in the same second; the older one's run id sorts after
        // the newer one's. Ordering by `updated_at` (second precision) plus a
        // random id would pick the wrong row.
        let mut older = new("t1");
        older.command = vec!["older".to_string()];
        let older = store.prepare(&older).expect("prepare older");
        let newer = prepare(&store, "t1");

        let latest = store
            .latest_for_tab("w-t1", "t1")
            .expect("read")
            .expect("exists");
        assert_eq!(latest.run_id, newer.run_id);
        assert_ne!(latest.run_id, older.run_id);
        assert!(
            latest.seq > 0,
            "the store orders by insertion sequence, not a mutable timestamp"
        );
    }

    #[test]
    fn ending_a_tab_closes_every_live_record_for_it() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");
        store.reconcile_after_restart().expect("reconcile");
        assert_eq!(
            store.interrupted_and_resumable().expect("eligible").len(),
            1
        );

        store.end_for_tab("t1").expect("end tab");

        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.state, InvocationState::Ended);
        assert_eq!(
            store.interrupted_and_resumable().expect("eligible").len(),
            0
        );
    }

    #[test]
    fn explicit_restore_retries_a_failed_attempt_with_its_harness_id() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store.reconcile_after_restart().expect("reconcile");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");

        store
            .fail(&prepared.run_id, "resume callback missing")
            .expect("fail");

        let record = store.resumable_for_tab("w-t1", "t1").expect("read");
        let record = record.expect("a failed attempt stays recoverable");
        assert_eq!(record.state, InvocationState::Failed);
        assert_eq!(record.harness_session_id.as_deref(), Some("harness-1"));
        assert_eq!(
            store.interrupted_and_resumable().expect("eligible").len(),
            0,
            "the proactive pass does not retry a failure forever"
        );
    }

    #[test]
    fn clearing_a_session_id_removes_the_resume_pointer() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");
        store.reconcile_after_restart().expect("reconcile");
        assert!(store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists")
            .is_auto_restorable());

        assert!(store
            .clear_harness_session_id(&prepared.run_id)
            .expect("clear"));

        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert!(record.harness_session_id.is_none());
        assert!(
            !record.is_auto_restorable(),
            "a cleared conversation is never auto-resumed"
        );
        assert_eq!(
            store.interrupted_and_resumable().expect("eligible").len(),
            0
        );
        assert!(store
            .resumable_for_tab("w-t1", "t1")
            .expect("read")
            .is_none());
    }

    #[test]
    fn a_stale_clear_cannot_clear_a_newer_run() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");
        store.reconcile_after_restart().expect("reconcile");
        assert!(store
            .rotate_execution(&prepared.invocation_id, "new-run")
            .expect("rotate"));
        assert!(store
            .set_harness_session_id("new-run", "harness-2")
            .expect("session id"));

        assert!(
            !store
                .clear_harness_session_id(&prepared.run_id)
                .expect("stale clear"),
            "the old execution no longer names a row"
        );

        assert_eq!(
            store
                .record("new-run")
                .expect("read")
                .expect("exists")
                .harness_session_id
                .as_deref(),
            Some("harness-2"),
            "the newer run keeps its conversation"
        );
    }

    #[test]
    fn a_run_that_never_reported_a_session_id_clears_to_nothing() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");

        // Pi's new/unmaterialized session: clearing before any id existed is
        // accepted and leaves nothing to resume.
        assert!(store
            .clear_harness_session_id(&prepared.run_id)
            .expect("clear"));
        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert!(record.harness_session_id.is_none());
        assert!(!record.is_explicitly_restorable());
    }

    #[test]
    fn rotating_execution_makes_the_old_run_stale_and_keeps_the_context() {
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store.reconcile_after_restart().expect("reconcile");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");

        assert!(store
            .rotate_execution(&prepared.invocation_id, "new-run")
            .expect("rotate"));

        let record = store.record("new-run").expect("read").expect("exists");
        assert_eq!(record.invocation_id, prepared.invocation_id);
        assert_eq!(record.state, InvocationState::Interrupted);
        assert_eq!(record.harness_session_id.as_deref(), Some("harness-1"));
        assert!(
            store.record(&prepared.run_id).expect("read").is_none(),
            "the old execution id no longer names a row"
        );
        assert!(
            !store.finish(&prepared.run_id, None).expect("old finish"),
            "a stale wrapper can never end the resumed execution"
        );
        assert!(
            !store
                .set_harness_session_id(&prepared.run_id, "stale")
                .expect("old id"),
            "a stale wrapper can never re-point the conversation"
        );
        assert!(
            store.start("new-run").expect("resumed start"),
            "the resumed wrapper's start acknowledges the new execution"
        );
        assert_eq!(
            store
                .record("new-run")
                .expect("read")
                .expect("exists")
                .state,
            InvocationState::Active
        );
    }

    #[test]
    fn a_failure_never_revives_an_ended_or_superseded_record() {
        let store = store();
        let ended = prepare(&store, "t1");
        store.start(&ended.run_id).expect("start");
        store.finish(&ended.run_id, Some(0)).expect("finish");
        store
            .fail(&ended.run_id, "late failure")
            .expect("fail is a no-op");
        assert_eq!(
            store
                .record(&ended.run_id)
                .expect("read")
                .expect("exists")
                .state,
            InvocationState::Ended,
            "a failure racing a close cannot reopen an ended record"
        );

        let live = prepare(&store, "t2");
        store.start(&live.run_id).expect("start");
        let _superseding = prepare(&store, "t2");
        store
            .fail(&live.run_id, "late failure")
            .expect("fail is a no-op");
        assert_eq!(
            store
                .record(&live.run_id)
                .expect("read")
                .expect("exists")
                .state,
            InvocationState::Superseded
        );
    }

    #[test]
    fn rotating_an_ended_or_superseded_record_is_rejected() {
        let store = store();
        let ended = prepare(&store, "t1");
        store.start(&ended.run_id).expect("start");
        store.finish(&ended.run_id, Some(0)).expect("finish");
        assert!(
            !store
                .rotate_execution(&ended.invocation_id, "new-run")
                .expect("rotate ended"),
            "an ended record is never resumed in place"
        );

        let live = prepare(&store, "t2");
        store.start(&live.run_id).expect("start");
        let _superseding = prepare(&store, "t2");
        assert!(
            !store
                .rotate_execution(&live.invocation_id, "other-run")
                .expect("rotate superseded"),
            "a superseded record is retired"
        );
    }

    #[test]
    fn replaying_a_completion_ends_the_execution_before_reconciliation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");
        let journal = completions_dir(dir.path());
        std::fs::create_dir_all(&journal).expect("journal dir");
        std::fs::write(journal.join(&prepared.run_id), "0").expect("journal entry");

        let applied = store
            .replay_completions(&completions_dir(dir.path()))
            .expect("replay");

        assert_eq!(applied, 1);
        let record = store
            .record(&prepared.run_id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.state, InvocationState::Ended);
        assert_eq!(record.exit_code, Some(0));
        // Reconciliation now finds nothing to interrupt.
        assert_eq!(store.reconcile_after_restart().expect("reconcile"), 0);
        assert_eq!(
            store.interrupted_and_resumable().expect("eligible").len(),
            0,
            "an intentional exit is not resurrected"
        );
        assert!(
            std::fs::read_dir(completions_dir(dir.path()))
                .expect("read dir")
                .next()
                .is_none(),
            "a replayed entry is consumed"
        );
    }

    #[test]
    fn replaying_a_stale_completion_leaves_the_current_execution_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store();
        let prepared = prepare(&store, "t1");
        store.start(&prepared.run_id).expect("start");
        store.reconcile_after_restart().expect("reconcile");
        store
            .set_harness_session_id(&prepared.run_id, "harness-1")
            .expect("session id");
        assert!(store
            .rotate_execution(&prepared.invocation_id, "new-run")
            .expect("rotate"));
        // The old wrapper finished after the resume: its completion names an
        // execution the record no longer carries.
        let journal = completions_dir(dir.path());
        std::fs::create_dir_all(&journal).expect("journal dir");
        std::fs::write(journal.join(&prepared.run_id), "0").expect("journal entry");

        store.replay_completions(&journal).expect("replay");

        assert_eq!(
            store
                .record("new-run")
                .expect("read")
                .expect("exists")
                .state,
            InvocationState::Interrupted
        );
    }

    #[test]
    fn an_unavailable_store_fails_every_operation_with_its_cause() {
        let store = InvocationStore::unavailable("disk on fire");
        assert!(!store.is_available());
        let error = store.prepare(&new("t1")).expect_err("must fail");
        assert!(error.to_string().contains("disk on fire"));
        assert!(store.start("r1").is_err());
        assert!(store.latest_for_tab("w", "t").is_err());
    }

    #[test]
    fn opens_and_migrates_a_legacy_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(INVOCATIONS_FILE);
        {
            // The pre-invocation-id shape, as an installed dev host has it.
            let connection = Connection::open(&path).expect("open legacy");
            connection
                .execute_batch(
                    "CREATE TABLE agent_invocations (
                       run_id TEXT PRIMARY KEY,
                       tab_id TEXT NOT NULL,
                       worktree_id TEXT NOT NULL,
                       project_id TEXT,
                       agent_id TEXT NOT NULL,
                       cwd TEXT NOT NULL,
                       shell TEXT,
                       command TEXT NOT NULL,
                       selection TEXT NOT NULL,
                       state TEXT NOT NULL,
                       harness_session_id TEXT,
                       failure TEXT,
                       exit_code INTEGER,
                       created_at INTEGER NOT NULL,
                       updated_at INTEGER NOT NULL
                     );
                     INSERT INTO agent_invocations (
                       run_id, tab_id, worktree_id, project_id, agent_id, cwd,
                       shell, command, selection, state, harness_session_id,
                       failure, exit_code, created_at, updated_at
                     ) VALUES (
                       'legacy-run', 't1', 'w-t1', 'p1', 'pragma.claude-code',
                       '/tmp/project', NULL, '[\"claude\"]',
                       '{\"modelId\":null,\"reasoningId\":null,\"modeId\":null,\"permissionModeId\":null,\"slashCommand\":null}',
                       'interrupted', 'harness-legacy', NULL, NULL, 1, 1
                     );",
                )
                .expect("legacy schema");
        }

        let store = InvocationStore::open(&path).expect("open migrates");

        let record = store
            .record("legacy-run")
            .expect("read")
            .expect("preserved");
        assert_eq!(record.invocation_id, "legacy-run");
        assert_eq!(record.harness_session_id.as_deref(), Some("harness-legacy"));
        assert!(record.seq > 0);
        assert!(record.is_auto_restorable());
    }
}
