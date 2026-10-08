//! AI operations on the host, and the jobs that outlive the request.
//!
//! Committing is not a request/response: it plans, then makes several commits,
//! then drafts a pull request, and the phone that started it may be
//! backgrounded, out of signal, or closed long before it finishes. So a
//! mutating operation here becomes a **job** — durable, resumable to look at,
//! and idempotent per caller request id — and the client polls it.
//!
//! Two rules follow from commits being irreversible:
//!
//! - A job is recorded as running *before* the first commit and its stage is
//!   written after every step, so a host that dies mid-run reports `interrupted`
//!   with the commits it already made, rather than looking like it never ran.
//! - Cancelling stops the next step. It never un-commits anything.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use pragma_core::ai::{CommitPlan, PullRequestContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::sidecar::run_oneshot;

/// Jobs are kept beside the socket so a restart can tell the user what was
/// interrupted rather than losing the record of commits that were made.
const JOBS_FILE: &str = "ai-jobs.json";
const SIDECAR_NAME: &str = "pragma-ai";
const SIDECAR_DEV_ENTRY: &str = "packages/ai-helpers/src/cli.ts";
/// How many finished jobs to remember, so a client that reconnects can still
/// read the result of the run it started.
const JOB_HISTORY_LIMIT: usize = 32;

#[derive(Debug, Error)]
pub enum AiError {
    #[error("invalid ai request: {0}")]
    InvalidRequest(String),
    #[error("ai operation failed: {0}")]
    Operation(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

/// Where a commit-and-draft job has got to.
///
/// The stages are what a client shows, and they are deliberately more than
/// "running": the difference between "still asking the model" and "already made
/// three commits" is exactly what a user needs when something goes wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiJobStage {
    Planning,
    Committing,
    Drafting,
    Ready,
    Failed,
    Cancelled,
    /// The host stopped while this job was running. Whatever it had already
    /// committed is still committed.
    Interrupted,
}

/// One commit-and-draft run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJob {
    pub job_id: String,
    pub request_id: String,
    pub worktree_id: String,
    pub stage: AiJobStage,
    /// Commits made so far. Meaningful in every stage, including a failure.
    pub commit_count: usize,
    pub title: Option<String>,
    pub body: Option<String>,
    pub error: Option<String>,
}

impl AiJob {
    fn finished(&self) -> bool {
        matches!(
            self.stage,
            AiJobStage::Ready
                | AiJobStage::Failed
                | AiJobStage::Cancelled
                | AiJobStage::Interrupted
        )
    }
}

/// What a job needs to run, resolved before it starts.
pub struct CommitAndDraftRequest {
    pub worktree_id: String,
    pub request_id: String,
    /// Absolute path of the worktree being committed.
    pub root: PathBuf,
    /// Branch this worktree came from, for the pull-request draft.
    pub parent_branch: String,
    /// The parent worktree's own checkout, when it is on this machine.
    pub parent_path: Option<PathBuf>,
    /// Held for the whole run so a desktop-initiated commit cannot interleave.
    pub project_lock: Arc<Mutex<()>>,
}

/// The host's AI jobs and the sidecar that does the work.
pub struct AiHost {
    jobs_path: PathBuf,
    jobs: Mutex<Vec<AiJob>>,
    /// Cancellation flags for jobs still running, by job id.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiHost {
    /// Loads the job record, marking anything that was running as interrupted.
    pub fn new(server_dir: &Path) -> Self {
        let jobs_path = server_dir.join(JOBS_FILE);
        let mut jobs: Vec<AiJob> = std::fs::read_to_string(&jobs_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        // Nothing is running in a process that has only just started. A job
        // still marked otherwise was cut off by whatever stopped the last one.
        for job in &mut jobs {
            if !job.finished() {
                job.stage = AiJobStage::Interrupted;
                job.error = Some(
                    "The host restarted while this run was in progress. Any commits it had already \
                     made are still there."
                        .to_string(),
                );
            }
        }
        let host = Self {
            jobs_path,
            jobs: Mutex::new(jobs),
            cancels: Mutex::new(HashMap::new()),
        };
        host.persist();
        host
    }

    /// Whether the AI sidecar is usable and signed in.
    pub fn status() -> Value {
        match run_oneshot(SIDECAR_NAME, SIDECAR_DEV_ENTRY, &["status"], &[], None) {
            Ok(value) => json!({
                "available": value.get("available").and_then(Value::as_bool).unwrap_or(false),
                // The sidecar reports the provider ids it holds credentials
                // for, not a flag: read it as a list, or every client is told
                // it is signed out while the host happily runs models.
                "signedIn": value
                    .get("signedIn")
                    .and_then(Value::as_array)
                    .is_some_and(|providers| !providers.is_empty()),
            }),
            Err(error) => json!({ "available": false, "signedIn": false, "error": error }),
        }
    }

    /// Writes a commit message for what is currently staged.
    ///
    /// Read-only, and staged-only: it describes what the user has already
    /// chosen to commit rather than everything in the worktree.
    pub fn commit_message(root: &Path) -> Result<Value, AiError> {
        let cwd = root.to_string_lossy().into_owned();
        let staged = pragma_core::git::stdout_in(root, &["diff", "--cached"])
            .map_err(|error| AiError::Operation(error.to_string()))?;
        if staged.trim().is_empty() {
            return Err(AiError::Operation(
                "There are no staged changes to describe.".to_string(),
            ));
        }
        Self::run_sidecar("commit-message", &cwd, &staged)
    }

    /// Drafts pull request text for the commits already on this branch.
    pub fn pull_request_draft(
        root: &Path,
        parent_branch: &str,
        parent_path: Option<&Path>,
    ) -> Result<Value, AiError> {
        let cwd = root.to_string_lossy().into_owned();
        let context = pragma_core::ai::pull_request_context(root, parent_branch, parent_path)
            .map_err(|error| AiError::Operation(error.to_string()))?;
        Self::run_sidecar("pull-request", &cwd, &serde_json::to_string(&context)?)
    }

    /// Proposes an edit to a document the caller supplies.
    ///
    /// The document travels in the request rather than being read from disk:
    /// the buffer a user is editing is what they mean, and it may not have been
    /// saved yet.
    pub fn inline_edit(root: &Path, payload: &Value) -> Result<Value, AiError> {
        let cwd = root.to_string_lossy().into_owned();
        Self::run_sidecar("inline-edit", &cwd, &payload.to_string())
    }

    /// Answers a question about the code.
    ///
    /// Read-only by construction: `ask` is the sidecar's question-answering
    /// command, not an agent. Anything that should be able to change files goes
    /// through `agents.launch`, where the user can see and approve what it does.
    pub fn ask(root: &Path, payload: &Value) -> Result<Value, AiError> {
        let cwd = root.to_string_lossy().into_owned();
        Self::run_sidecar("ask", &cwd, &payload.to_string())
    }

    /// Starts a commit-and-draft run, or returns the one this request already
    /// started.
    ///
    /// Returning immediately is the point: the run makes commits, and a phone
    /// that loses signal halfway through must not leave the work half-done or
    /// start it twice when it comes back.
    pub fn start_commit_and_draft(
        self: &Arc<Self>,
        request: CommitAndDraftRequest,
    ) -> Result<AiJob, AiError> {
        if let Some(existing) = self.job_for_request(&request.request_id)? {
            return Ok(existing);
        }
        let job = AiJob {
            job_id: uuid::Uuid::new_v4().to_string(),
            request_id: request.request_id.clone(),
            worktree_id: request.worktree_id.clone(),
            stage: AiJobStage::Planning,
            commit_count: 0,
            title: None,
            body: None,
            error: None,
        };
        self.insert(job.clone())?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .map_err(|_| AiError::LockPoisoned)?
            .insert(job.job_id.clone(), Arc::clone(&cancel));
        let host = Arc::clone(self);
        let job_id = job.job_id.clone();
        thread::spawn(move || {
            let outcome = host.run_commit_and_draft(&job_id, &request, &cancel);
            host.finish(&job_id, outcome);
        });
        Ok(job)
    }

    /// The job with this id.
    pub fn job(&self, job_id: &str) -> Result<Option<AiJob>, AiError> {
        Ok(self
            .jobs
            .lock()
            .map_err(|_| AiError::LockPoisoned)?
            .iter()
            .find(|job| job.job_id == job_id)
            .cloned())
    }

    /// Asks a running job to stop before its next step.
    ///
    /// This does not undo commits, and says so: what has been committed stays
    /// committed, because rewriting history to "cancel" would destroy work.
    pub fn cancel(&self, job_id: &str) -> Result<(), AiError> {
        if let Some(cancel) = self
            .cancels
            .lock()
            .map_err(|_| AiError::LockPoisoned)?
            .get(job_id)
        {
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    }

    /// Runs the whole operation, reporting each stage as it starts.
    fn run_commit_and_draft(
        &self,
        job_id: &str,
        request: &CommitAndDraftRequest,
        cancel: &AtomicBool,
    ) -> Result<(Option<String>, Option<String>), AiError> {
        // The project lock is shared with the desktop's own AI commit path, so
        // two entry points cannot stage against each other's index.
        let _guard = request
            .project_lock
            .lock()
            .map_err(|_| AiError::LockPoisoned)?;
        let root = request.root.as_path();
        let cwd = root.to_string_lossy().into_owned();

        let context = pragma_core::ai::commit_plan_context(root)
            .map_err(|error| AiError::Operation(error.to_string()))?;
        if context.allowed_paths.is_empty() {
            return Err(AiError::Operation(
                "There are no changes to commit.".to_string(),
            ));
        }
        if cancel.load(Ordering::Acquire) {
            return Err(AiError::Operation("cancelled".to_string()));
        }

        let value = Self::run_sidecar("commit-plan", &cwd, &serde_json::to_string(&context)?)?;
        let plan: CommitPlan = serde_json::from_value(value)?;
        let commits = pragma_core::ai::normalize_commit_plan(plan, &context.allowed_paths)
            .map_err(|error| AiError::Operation(error.to_string()))?;
        if cancel.load(Ordering::Acquire) {
            // Nothing has been committed yet, so stopping here costs nothing.
            return Err(AiError::Operation("cancelled".to_string()));
        }

        // Re-read the changed set: the model took time to answer, and a file
        // saved meanwhile would otherwise be committed under a message written
        // before it existed.
        let current = pragma_core::ai::changed_paths(root)
            .map_err(|error| AiError::Operation(error.to_string()))?;
        if current != context.allowed_paths {
            return Err(AiError::Operation(
                "The worktree changed while the commit plan was being written. Nothing was \
                 committed; try again."
                    .to_string(),
            ));
        }

        self.set_stage(job_id, AiJobStage::Committing)?;
        let made = pragma_core::ai::apply_commit_plan(root, &commits)
            .map_err(|error| AiError::Operation(error.to_string()))?;
        self.set_commit_count(job_id, made)?;

        self.set_stage(job_id, AiJobStage::Drafting)?;
        let draft = Self::draft_pull_request(&cwd, root, request)?;
        Ok(draft)
    }

    /// Drafts the pull request text for the branch's own commits.
    fn draft_pull_request(
        cwd: &str,
        root: &Path,
        request: &CommitAndDraftRequest,
    ) -> Result<(Option<String>, Option<String>), AiError> {
        let context: PullRequestContext = pragma_core::ai::pull_request_context(
            root,
            &request.parent_branch,
            request.parent_path.as_deref(),
        )
        .map_err(|error| AiError::Operation(error.to_string()))?;
        let value = Self::run_sidecar("pull-request", cwd, &serde_json::to_string(&context)?)?;
        Ok((
            value
                .get("title")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            value
                .get("body")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ))
    }

    fn run_sidecar(command: &str, cwd: &str, stdin_data: &str) -> Result<Value, AiError> {
        run_oneshot(
            SIDECAR_NAME,
            SIDECAR_DEV_ENTRY,
            &[command, "--cwd", cwd],
            &[],
            Some(stdin_data),
        )
        .map_err(AiError::Operation)
    }

    fn finish(&self, job_id: &str, outcome: Result<(Option<String>, Option<String>), AiError>) {
        let _ = self
            .cancels
            .lock()
            .map(|mut cancels| cancels.remove(job_id));
        let _ = self.update(job_id, |job| match outcome {
            Ok((title, body)) => {
                job.stage = AiJobStage::Ready;
                job.title = title;
                job.body = body;
            }
            Err(error) => {
                let message = error.to_string();
                // A cancelled run is not a failure to report as one — but the
                // commits it already made are still reported.
                job.stage = if message.contains("cancelled") {
                    AiJobStage::Cancelled
                } else {
                    AiJobStage::Failed
                };
                job.error = Some(message);
            }
        });
    }

    fn set_stage(&self, job_id: &str, stage: AiJobStage) -> Result<(), AiError> {
        self.update(job_id, |job| job.stage = stage)
    }

    fn set_commit_count(&self, job_id: &str, count: usize) -> Result<(), AiError> {
        self.update(job_id, |job| job.commit_count = count)
    }

    fn update(&self, job_id: &str, mutate: impl FnOnce(&mut AiJob)) -> Result<(), AiError> {
        {
            let mut jobs = self.jobs.lock().map_err(|_| AiError::LockPoisoned)?;
            let Some(job) = jobs.iter_mut().find(|job| job.job_id == job_id) else {
                return Ok(());
            };
            mutate(job);
        }
        self.persist();
        Ok(())
    }

    fn insert(&self, job: AiJob) -> Result<(), AiError> {
        {
            let mut jobs = self.jobs.lock().map_err(|_| AiError::LockPoisoned)?;
            jobs.push(job);
            let overflow = jobs.len().saturating_sub(JOB_HISTORY_LIMIT);
            if overflow > 0 {
                // Only finished jobs are forgotten; a running one is still the
                // record of commits in flight.
                let mut dropped = 0;
                jobs.retain(|job| {
                    if dropped >= overflow || !job.finished() {
                        return true;
                    }
                    dropped += 1;
                    false
                });
            }
        }
        self.persist();
        Ok(())
    }

    fn job_for_request(&self, request_id: &str) -> Result<Option<AiJob>, AiError> {
        Ok(self
            .jobs
            .lock()
            .map_err(|_| AiError::LockPoisoned)?
            .iter()
            .find(|job| job.request_id == request_id)
            .cloned())
    }

    /// Writes the job record. Best-effort: a failed write costs the "what was
    /// interrupted" report after a restart, not the commits themselves.
    fn persist(&self) {
        let Ok(jobs) = self.jobs.lock() else {
            return;
        };
        let Ok(contents) = serde_json::to_string(&*jobs) else {
            return;
        };
        if let Err(error) = std::fs::write(&self.jobs_path, contents) {
            eprintln!("failed to persist ai jobs: {error}");
        }
    }
}

impl From<serde_json::Error> for AiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Operation(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{AiHost, AiJob, AiJobStage};

    fn job(stage: AiJobStage) -> AiJob {
        AiJob {
            job_id: "job-1".to_string(),
            request_id: "request-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            stage,
            commit_count: 3,
            title: None,
            body: None,
            error: None,
        }
    }

    #[test]
    fn a_job_running_when_the_host_stopped_comes_back_interrupted() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("ai-jobs.json"),
            serde_json::to_string(&[job(AiJobStage::Committing)]).expect("serialize"),
        )
        .expect("write");

        let host = AiHost::new(dir.path());
        let restored = host.job("job-1").expect("read").expect("job");

        assert_eq!(restored.stage, AiJobStage::Interrupted);
        // The commits it made are real, and saying otherwise would send the
        // user looking for work that is already on the branch.
        assert_eq!(restored.commit_count, 3);
        assert!(restored.error.is_some());
    }

    #[test]
    fn a_finished_job_survives_a_restart_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut done = job(AiJobStage::Ready);
        done.title = Some("Fix session reconnect".to_string());
        std::fs::write(
            dir.path().join("ai-jobs.json"),
            serde_json::to_string(&[done]).expect("serialize"),
        )
        .expect("write");

        let restored = AiHost::new(dir.path())
            .job("job-1")
            .expect("read")
            .expect("job");

        assert_eq!(restored.stage, AiJobStage::Ready);
        assert_eq!(restored.title.as_deref(), Some("Fix session reconnect"));
    }

    #[test]
    fn an_absent_or_corrupt_record_is_simply_no_jobs() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(AiHost::new(dir.path())
            .job("job-1")
            .expect("read")
            .is_none());

        std::fs::write(dir.path().join("ai-jobs.json"), "{ not json").expect("write");
        assert!(AiHost::new(dir.path())
            .job("job-1")
            .expect("read")
            .is_none());
    }

    #[test]
    fn cancelling_an_unknown_job_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A client whose job finished before its cancel arrived is not a fault.
        AiHost::new(dir.path()).cancel("job-gone").expect("cancel");
    }
}
