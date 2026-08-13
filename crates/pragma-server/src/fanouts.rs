//! Durable fanout orchestration.
//!
//! A fanout launches one prompt into N isolated attempt worktrees under a
//! single parent, tracks every attempt, and finally merges one of them back.
//! The record is host-owned and persisted, so a fanout behaves identically
//! whether a desktop client is attached, closed, or restarting — the desktop is
//! a subscriber and a controller, never the process owner.
//!
//! This module is split in two on purpose:
//!
//! - [`FanoutHost`] is the seam for everything with a side effect (git, PTYs,
//!   the plugin catalog, the AI commit-message helper, the filesystem).
//!   `Registry` implements it against the real host.
//! - [`FanoutStore`] owns the durable record, the state machine, subscriptions,
//!   and the ordering rules — including the destructive pick transaction. It is
//!   generic over the host, so every rule here is tested against a fake one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};

use pragma_constants::FanoutSendTargetKind;
use pragma_constants::{
    Fanout, FanoutCreateRequest, FanoutDeliveryReceipt, FanoutDeliveryState, FanoutFailure,
    FanoutFailureCode, FanoutFinalizeStage, FanoutMember, FanoutMemberRequest, FanoutMemberStatus,
    FanoutParentSpec, FanoutPickResult, FanoutReadRequest, FanoutReadResult, FanoutReadTarget,
    FanoutRef, FanoutResult, FanoutSendRequest, FanoutSendResult, FanoutStatus,
    FanoutSubscriptionPayload, ProtocolEventKind, CONSTANTS,
};
use pragma_core::fanout::{
    aggregate_status, attempt_branch, derive_title, failure, is_active, member_failure,
    promotion_path, resolve_selector, CatalogAgentView,
};
use pragma_protocol::EventFrame;
use uuid::Uuid;

/// A worktree as the fanout domain needs to see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeView {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub branch: String,
    pub path: String,
}

/// Everything one attempt launch needs. The catalog id resolves the launch
/// command; the runtime id is what the agent event stream is keyed by. They are
/// carried separately because deriving one from the other at a call site is how
/// they drift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub project_id: String,
    pub worktree_id: String,
    pub cwd: String,
    pub catalog_agent_id: String,
    pub runtime_agent_id: String,
    pub model_id: Option<String>,
    pub reasoning_id: Option<String>,
    pub prompt: String,
    pub fanout_id: String,
    pub member_id: String,
}

/// One live follow-up target, addressed exactly.
// Every field is an identifier by design: a delivery is only ever aimed at one
// exact (worktree, tab, agent) triple.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryTarget {
    pub worktree_id: String,
    pub tab_id: String,
    pub runtime_agent_id: String,
}

/// One scratchpad being promoted out of the winner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScratchpadCopy {
    pub file_path: String,
    pub contents: String,
    /// The sibling comment thread, when the scratchpad has one.
    pub comments: Option<String>,
}

/// A host failure carrying the machine-readable code callers branch on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub code: FanoutFailureCode,
    pub message: String,
}

impl HostError {
    pub fn new(code: FanoutFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn into_failure(self) -> FanoutFailure {
        failure(self.code, self.message)
    }
}

/// Result of a host operation.
pub type HostResult<T> = Result<T, HostError>;

/// Every side effect fanout orchestration performs.
pub trait FanoutHost {
    /// Absolute project root on this host.
    fn project_root(&self, project_id: &str) -> HostResult<String>;
    /// One worktree of a project.
    fn worktree(&self, project_id: &str, worktree_id: &str) -> HostResult<WorktreeView>;
    /// Any worktree by id, across projects — used to resolve a `FanoutRef`.
    fn find_worktree(&self, worktree_id: &str) -> Option<WorktreeView>;
    /// Worktrees whose parent is `worktree_id`. A fanout refuses to finalize
    /// while an attempt still has descendants.
    fn child_worktree_ids(&self, worktree_id: &str) -> Vec<String>;
    /// Launchable agents, already scoped to this project root.
    fn catalog(&self, project_root: &str) -> HostResult<Vec<CatalogAgentView>>;
    /// Exact `HEAD` of a checkout.
    fn head_commit(&self, root: &str) -> HostResult<String>;
    /// True when a checkout has staged, unstaged, or untracked changes.
    fn is_dirty(&self, root: &str) -> HostResult<bool>;
    /// Creates a worktree on `branch` at exactly `commit`, runs the project's
    /// setup scripts in it, and returns the new worktree.
    fn create_worktree(
        &self,
        project_id: &str,
        parent_worktree_id: &str,
        branch: &str,
        commit: &str,
        title: Option<&str>,
    ) -> HostResult<WorktreeView>;
    /// Opens one agent-owned terminal tab and delivers the prompt. Returns the
    /// tab id.
    fn launch_agent(&self, spec: &LaunchSpec) -> HostResult<String>;
    /// Bounded tail of a tab's output: `(raw bytes, escape-stripped text)`.
    fn read_tab(&self, tab_id: &str, lines: usize) -> HostResult<(Vec<u8>, String)>;
    /// Hands one follow-up to the watcher that owns this exact session.
    fn deliver_message(
        &self,
        target: &DeliveryTarget,
        message: &str,
        message_id: &str,
        wait: bool,
    ) -> FanoutDeliveryState;
    /// Terminates an attempt's session and its watcher.
    fn stop_tab(&self, tab_id: &str);
    /// Asks the `pragma-ai` helper for a commit message describing the staged
    /// changes. There is deliberately no fallback: a wrong message on the
    /// winner's only commit is worse than a stopped, retryable finalize.
    fn generate_commit_message(&self, root: &str) -> HostResult<String>;
    /// Stages everything and commits it. `Ok(None)` when nothing was dirty.
    fn stage_and_commit(&self, root: &str, message: &str) -> HostResult<Option<String>>;
    /// Merges an attempt branch into the parent worktree.
    fn merge_into_parent(&self, parent: &WorktreeView, child: &WorktreeView) -> HostResult<()>;
    /// Managed scratchpads of a checkout, comment threads included.
    fn list_scratchpads(&self, root: &str) -> HostResult<Vec<ScratchpadCopy>>;
    /// Reads a worktree-relative file, or `None` when absent.
    fn read_file(&self, root: &str, path: &str) -> Option<String>;
    /// Writes a worktree-relative file, creating parent directories.
    fn write_file(&self, root: &str, path: &str, contents: &str) -> HostResult<()>;
    /// Removes an attempt's checkout and its local branch.
    fn delete_worktree(&self, worktree: &WorktreeView) -> HostResult<()>;
}

/// Durable fanout state for one host.
pub struct FanoutStore {
    server_dir: PathBuf,
    state: Mutex<FanoutState>,
    subscribers: Mutex<Vec<Sender<EventFrame>>>,
    /// Serializes the destructive pick transaction across the whole host: two
    /// concurrent picks on one parent would race on the same branches.
    finalize: Mutex<()>,
}

#[derive(Default)]
struct FanoutState {
    fanouts: Vec<Fanout>,
    /// `idempotencyKey -> fanoutId`, so a retried create returns the existing
    /// fanout instead of provisioning a second set of worktrees.
    idempotency: HashMap<String, String>,
    /// `(messageId, memberId)` pairs already delivered, so a retried send does
    /// not type the same follow-up into a member twice.
    delivered: HashSet<(String, String)>,
}

impl FanoutStore {
    /// Loads the persisted record from `server_dir`, or starts empty.
    ///
    /// A corrupt file is dropped rather than fatal: refusing to start would
    /// take every session on the host down with it, and the desktop can always
    /// be told the truth (nothing is tracked) instead of a lie (stale members).
    #[must_use]
    pub fn load(server_dir: &Path) -> Self {
        let fanouts = std::fs::read_to_string(server_dir.join(&CONSTANTS.fanout.state_file))
            .ok()
            .and_then(|contents| serde_json::from_str::<Vec<Fanout>>(&contents).ok())
            .unwrap_or_default();
        Self {
            server_dir: server_dir.to_path_buf(),
            state: Mutex::new(FanoutState {
                fanouts,
                ..FanoutState::default()
            }),
            subscribers: Mutex::new(Vec::new()),
            finalize: Mutex::new(()),
        }
    }

    /// Marks every member that was live when the host stopped as `interrupted`.
    ///
    /// The prompt is never replayed automatically: the attempt's worktree may
    /// already hold work, and a second prompt into a half-finished attempt is
    /// unrecoverable. `retry` is the explicit way forward.
    pub fn reconcile_after_restart(&self) {
        let mut state = self.lock();
        let mut changed = false;
        for fanout in &mut state.fanouts {
            if !is_active(fanout) {
                continue;
            }
            for member in &mut fanout.members {
                if matches!(
                    member.status,
                    FanoutMemberStatus::Running
                        | FanoutMemberStatus::Attention
                        | FanoutMemberStatus::Pending
                        | FanoutMemberStatus::Provisioning
                ) {
                    member.status = FanoutMemberStatus::Interrupted;
                    changed = true;
                }
            }
            refresh_status(fanout);
        }
        if changed {
            self.persist_locked(&state);
        }
        drop(state);
        self.broadcast();
    }

    /// Every fanout this host tracks, newest last.
    #[cfg(test)]
    pub fn all(&self) -> Vec<Fanout> {
        self.lock().fanouts.clone()
    }

    /// Snapshot-then-delta subscription, mirroring the workspace stream.
    pub fn subscribe(&self) -> (Vec<EventFrame>, Receiver<EventFrame>) {
        let (tx, rx) = mpsc::channel();
        let snapshot = {
            let state = self.lock();
            let payload = payload_value(&state.fanouts);
            if let Ok(mut subscribers) = self.subscribers.lock() {
                subscribers.push(tx);
            }
            payload
        };
        (
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::Fanouts,
                payload: snapshot,
            }],
            rx,
        )
    }

    /// Reflects a live agent status report onto the member that owns the tab.
    ///
    /// Fanout status stays distinct from agent runtime status: an agent going
    /// idle makes its member `done`, which may or may not make the fanout
    /// `ready` depending on its siblings.
    pub fn apply_agent_status(&self, tab_id: &str, status: FanoutMemberStatus) {
        let mut state = self.lock();
        let mut changed = false;
        for fanout in &mut state.fanouts {
            if !is_active(fanout) {
                continue;
            }
            for member in &mut fanout.members {
                if member.tab_id.as_deref() != Some(tab_id) {
                    continue;
                }
                // `selected` and terminal failure states are owned by the
                // orchestrator, never by an incoming status report.
                if matches!(
                    member.status,
                    FanoutMemberStatus::Selected
                        | FanoutMemberStatus::Cancelled
                        | FanoutMemberStatus::Failed
                ) {
                    continue;
                }
                if member.status != status {
                    member.status = status;
                    changed = true;
                }
            }
            if changed {
                refresh_status(fanout);
            }
        }
        if changed {
            self.persist_locked(&state);
            drop(state);
            self.broadcast();
        }
    }

    // ---------------------------------------------------------------- create

    /// Provisions a whole fanout: one parent, N attempt worktrees branched from
    /// one captured commit, and one agent-owned tab per attempt.
    ///
    /// Everything that can be rejected is rejected *before* the first side
    /// effect — an unknown model must not leave half a fanout on disk. Once
    /// provisioning starts, a member that fails does not roll back its healthy
    /// siblings; the fanout goes `partial` and the member is retryable.
    pub fn create<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutCreateRequest,
    ) -> Result<FanoutResult, FanoutFailure> {
        if let Some(existing) = self.existing_for_key(request.idempotency_key.as_deref()) {
            return Ok(result_for(existing));
        }
        let plan = Self::preflight(host, request)?;
        let (parent, base_commit) = self.resolve_parent(host, request, &plan)?;
        let fanout = self.persist_provisioning(request, &plan, &parent, &base_commit);
        let fanout_id = fanout.id.clone();
        self.broadcast();

        let jobs = request
            .jobs
            .map_or_else(
                || usize::try_from(CONSTANTS.fanout.default_jobs.get()).unwrap_or(1),
                |jobs| usize::try_from(jobs.get()).unwrap_or(1),
            )
            .max(1);
        self.provision_members(host, &fanout_id, &parent, &base_commit, jobs);
        let fanout = self
            .get_by_id(&fanout_id)
            .ok_or_else(|| failure(FanoutFailureCode::Internal, "fanout disappeared"))?;
        Ok(result_for(fanout))
    }

    /// Resolves every selector, model, and reasoning id against the catalog of
    /// the *target* project, and enforces the member-count floor. There is no
    /// ceiling: the caller decides how many attempts are worth the cost.
    fn preflight<H: FanoutHost>(
        host: &H,
        request: &FanoutCreateRequest,
    ) -> Result<CreatePlan, FanoutFailure> {
        let min = usize::try_from(CONSTANTS.fanout.min_members).unwrap_or(2);
        if request.members.len() < min {
            return Err(failure(
                FanoutFailureCode::InvalidSelector,
                format!("a fanout needs at least {min} attempts"),
            ));
        }
        if request.prompt.trim().is_empty() {
            return Err(failure(
                FanoutFailureCode::InvalidSelector,
                "a fanout needs a prompt",
            ));
        }
        let project_root = host
            .project_root(&request.project_id)
            .map_err(HostError::into_failure)?;
        let catalog = host
            .catalog(&project_root)
            .map_err(HostError::into_failure)?;
        let default_reasoning = request.default_reasoning_id.as_deref();
        let mut resolved = Vec::with_capacity(request.members.len());
        for selector in &request.members {
            let mut member = resolve_selector(
                &catalog,
                &selector.selector,
                selector.reasoning_id.as_deref().or(default_reasoning),
            )?;
            // An explicitly structured caller (the desktop) sets the ids
            // directly; they win over anything parsed out of the text.
            if let Some(model_id) = selector.model_id.clone() {
                member.model_id = Some(model_id);
            }
            if let Some(reasoning_id) = selector.reasoning_id.clone() {
                member.reasoning_id = Some(reasoning_id);
            }
            resolved.push(member);
        }
        Ok(CreatePlan { members: resolved })
    }

    /// Resolves the fanout's single parent and captures its exact `HEAD`.
    fn resolve_parent<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutCreateRequest,
        plan: &CreatePlan,
    ) -> Result<(WorktreeView, String), FanoutFailure> {
        let _ = plan;
        match &request.parent {
            FanoutParentSpec::ExistingParent(existing) => {
                let parent = host
                    .worktree(&request.project_id, &existing.worktree_id)
                    .map_err(HostError::into_failure)?;
                self.reject_when_parent_busy(&parent.id)?;
                Self::require_clean(host, &parent)?;
                let commit = host
                    .head_commit(&parent.path)
                    .map_err(HostError::into_failure)?;
                Ok((parent, commit))
            }
            FanoutParentSpec::NewParent(spec) => {
                let source = host
                    .worktree(&request.project_id, &spec.source_worktree_id)
                    .map_err(HostError::into_failure)?;
                Self::require_clean(host, &source)?;
                let source_commit = host
                    .head_commit(&source.path)
                    .map_err(HostError::into_failure)?;
                let parent = host
                    .create_worktree(
                        &request.project_id,
                        &source.id,
                        spec.branch.trim(),
                        &source_commit,
                        spec.title.as_deref(),
                    )
                    .map_err(HostError::into_failure)?;
                let commit = host
                    .head_commit(&parent.path)
                    .map_err(HostError::into_failure)?;
                Ok((parent, commit))
            }
        }
    }

    /// A parent may own at most one fanout that has not reached a terminal
    /// state — otherwise "the fanout of this worktree" stops being a question
    /// with an answer.
    fn reject_when_parent_busy(&self, parent_worktree_id: &str) -> Result<(), FanoutFailure> {
        let state = self.lock();
        if state
            .fanouts
            .iter()
            .any(|fanout| fanout.parent_worktree_id == parent_worktree_id && is_active(fanout))
        {
            return Err(failure(
                FanoutFailureCode::ActiveFanoutExists,
                "this worktree already has an active fanout",
            ));
        }
        Ok(())
    }

    /// Git worktrees inherit commits, not uncommitted bytes. Fanning out from a
    /// dirty parent would give every attempt a different starting point than
    /// the one the user is looking at, and make the comparison a lie.
    fn require_clean<H: FanoutHost>(
        host: &H,
        worktree: &WorktreeView,
    ) -> Result<(), FanoutFailure> {
        if host
            .is_dirty(&worktree.path)
            .map_err(HostError::into_failure)?
        {
            return Err(failure(
                FanoutFailureCode::DirtyParent,
                format!(
                    "commit, stash, or discard the changes in `{}` before fanning out — attempts branch from a commit, not from the working tree",
                    worktree.branch
                ),
            ));
        }
        Ok(())
    }

    /// Writes the provisioning record before anything exists on disk, so a
    /// crash mid-create leaves a record to reconcile rather than orphans.
    fn persist_provisioning(
        &self,
        request: &FanoutCreateRequest,
        plan: &CreatePlan,
        parent: &WorktreeView,
        base_commit: &str,
    ) -> Fanout {
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let members = plan
            .members
            .iter()
            .enumerate()
            .map(|(ordinal, resolved)| {
                let member_id = member_id();
                FanoutMember {
                    branch: attempt_branch(&id, &member_id),
                    id: member_id,
                    ordinal: u64::try_from(ordinal).unwrap_or_default(),
                    selector: resolved.selector.clone(),
                    catalog_agent_id: resolved.catalog_agent_id.clone(),
                    runtime_agent_id: resolved.runtime_agent_id.clone(),
                    model_id: resolved.model_id.clone(),
                    reasoning_id: resolved.reasoning_id.clone(),
                    worktree_id: None,
                    tab_id: None,
                    prior_tab_ids: Vec::new(),
                    status: FanoutMemberStatus::Pending,
                    failure: None,
                }
            })
            .collect();
        let source_worktree_id = match &request.parent {
            FanoutParentSpec::NewParent(spec) => Some(spec.source_worktree_id.clone()),
            FanoutParentSpec::ExistingParent(_) => None,
        };
        let fanout = Fanout {
            id,
            project_id: request.project_id.clone(),
            parent_worktree_id: parent.id.clone(),
            source_worktree_id,
            owns_parent: matches!(request.parent, FanoutParentSpec::NewParent(_)),
            base_commit: base_commit.to_string(),
            title: request
                .title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map_or_else(|| derive_title(&request.prompt), str::to_string),
            prompt: request.prompt.clone(),
            status: FanoutStatus::Provisioning,
            winning_member_id: None,
            finalize_stage: None,
            failure: None,
            members,
            created_at: now.clone(),
            updated_at: now,
        };
        let mut state = self.lock();
        if let Some(key) = request.idempotency_key.clone() {
            state.idempotency.insert(key, fanout.id.clone());
        }
        state.fanouts.push(fanout.clone());
        self.persist_locked(&state);
        fanout
    }

    /// Creates each attempt's worktree and launches its agent.
    ///
    /// Worktree creation is serialized (git mutates one repository's admin
    /// state) while launches run in bounded batches, so a five-way fanout does
    /// not open five cold TUIs at once.
    fn provision_members<H: FanoutHost>(
        &self,
        host: &H,
        fanout_id: &str,
        parent: &WorktreeView,
        base_commit: &str,
        jobs: usize,
    ) {
        let members: Vec<FanoutMember> = self
            .get_by_id(fanout_id)
            .map(|fanout| fanout.members)
            .unwrap_or_default();
        for batch in members.chunks(jobs) {
            for member in batch {
                self.provision_member(host, fanout_id, member, parent, base_commit);
            }
        }
        self.mutate(fanout_id, |fanout| {
            refresh_status(fanout);
        });
        self.broadcast();
    }

    /// Provisions one attempt. Idempotent: a member that already has a worktree
    /// keeps it, so a retried create never opens a second checkout.
    fn provision_member<H: FanoutHost>(
        &self,
        host: &H,
        fanout_id: &str,
        member: &FanoutMember,
        parent: &WorktreeView,
        base_commit: &str,
    ) {
        let member_id = member.id.clone();
        self.mutate(fanout_id, |fanout| {
            if let Some(member) = find_member_mut(fanout, &member_id) {
                member.status = FanoutMemberStatus::Provisioning;
                member.failure = None;
            }
        });
        let worktree = match member
            .worktree_id
            .as_ref()
            .and_then(|id| host.find_worktree(id))
        {
            Some(existing) => existing,
            None => match host.create_worktree(
                &parent.project_id,
                &parent.id,
                &member.branch,
                base_commit,
                None,
            ) {
                Ok(worktree) => worktree,
                Err(error) => {
                    self.fail_member(fanout_id, &member_id, error.code, &error.message);
                    return;
                }
            },
        };
        let spec = LaunchSpec {
            project_id: parent.project_id.clone(),
            worktree_id: worktree.id.clone(),
            cwd: worktree.path.clone(),
            catalog_agent_id: member.catalog_agent_id.clone(),
            runtime_agent_id: member.runtime_agent_id.clone(),
            model_id: member.model_id.clone(),
            reasoning_id: member.reasoning_id.clone(),
            prompt: self
                .get_by_id(fanout_id)
                .map(|fanout| fanout.prompt)
                .unwrap_or_default(),
            fanout_id: fanout_id.to_string(),
            member_id: member_id.clone(),
        };
        let launched = host.launch_agent(&spec);
        self.mutate(fanout_id, |fanout| {
            let Some(member) = find_member_mut(fanout, &member_id) else {
                return;
            };
            member.worktree_id = Some(worktree.id.clone());
            match &launched {
                Ok(tab_id) => {
                    if let Some(previous) = member.tab_id.replace(tab_id.clone()) {
                        member.prior_tab_ids.push(previous);
                    }
                    member.status = FanoutMemberStatus::Running;
                    member.failure = None;
                }
                Err(error) => {
                    member.status = FanoutMemberStatus::Failed;
                    member.failure = Some(member_failure(
                        error.code,
                        &member_id,
                        error.message.clone(),
                    ));
                }
            }
        });
    }

    // ------------------------------------------------------------- accessors

    /// Resolves a `FanoutRef` — by id, or by any worktree that belongs to one.
    pub fn resolve(&self, reference: &FanoutRef) -> Result<Fanout, FanoutFailure> {
        self.resolve_parts(
            reference.fanout_id.as_deref(),
            reference.worktree_id.as_deref(),
        )
    }

    fn resolve_parts(
        &self,
        fanout_id: Option<&str>,
        worktree_id: Option<&str>,
    ) -> Result<Fanout, FanoutFailure> {
        let state = self.lock();
        if let Some(id) = fanout_id.filter(|id| !id.is_empty()) {
            return state
                .fanouts
                .iter()
                .find(|fanout| fanout.id == id)
                .cloned()
                .ok_or_else(|| failure(FanoutFailureCode::NotFound, format!("no fanout `{id}`")));
        }
        let Some(worktree_id) = worktree_id.filter(|id| !id.is_empty()) else {
            return Err(failure(
                FanoutFailureCode::NotFound,
                "pass a fanout id, or run inside a fanout parent or attempt",
            ));
        };
        // An attempt resolves its owning fanout; a parent resolves its single
        // active one. Completed fanouts stay addressable by exact id only, so
        // a reused parent never resolves to yesterday's record.
        state
            .fanouts
            .iter()
            .find(|fanout| {
                fanout
                    .members
                    .iter()
                    .any(|member| member.worktree_id.as_deref() == Some(worktree_id))
            })
            .or_else(|| {
                state
                    .fanouts
                    .iter()
                    .find(|fanout| fanout.parent_worktree_id == worktree_id && is_active(fanout))
            })
            .cloned()
            .ok_or_else(|| {
                failure(
                    FanoutFailureCode::NotFound,
                    format!("worktree `{worktree_id}` has no fanout"),
                )
            })
    }

    #[must_use]
    pub fn get_by_id(&self, fanout_id: &str) -> Option<Fanout> {
        self.lock()
            .fanouts
            .iter()
            .find(|fanout| fanout.id == fanout_id)
            .cloned()
    }

    fn existing_for_key(&self, key: Option<&str>) -> Option<Fanout> {
        let key = key?;
        let state = self.lock();
        let id = state.idempotency.get(key)?.clone();
        state.fanouts.iter().find(|fanout| fanout.id == id).cloned()
    }

    // ------------------------------------------------------------------ read

    /// Bounded terminal output for one member, or every live member.
    pub fn read<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutReadRequest,
    ) -> Result<FanoutReadResult, FanoutFailure> {
        let fanout =
            self.resolve_parts(request.fanout_id.as_deref(), request.worktree_id.as_deref())?;
        let lines = request
            .lines
            .and_then(|lines| usize::try_from(lines.get()).ok())
            .unwrap_or(DEFAULT_READ_LINES);
        let members = select_members(&fanout, request.member_id.as_deref(), request.all)?;
        let mut targets = Vec::with_capacity(members.len());
        for member in members {
            let (Some(worktree_id), Some(tab_id)) = (&member.worktree_id, &member.tab_id) else {
                continue;
            };
            let (raw, text) = host
                .read_tab(tab_id, lines)
                .map_err(HostError::into_failure)?;
            targets.push(FanoutReadTarget {
                member_id: member.id.clone(),
                worktree_id: worktree_id.clone(),
                tab_id: tab_id.clone(),
                runtime_agent_id: member.runtime_agent_id.clone(),
                bytes: u64::try_from(raw.len()).unwrap_or_default(),
                data: base64_encode(&raw),
                text,
            });
        }
        Ok(FanoutReadResult {
            fanout_id: fanout.id,
            targets,
        })
    }

    // ------------------------------------------------------------------ send

    /// Delivers a follow-up to one member or to every live member.
    pub fn send<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutSendRequest,
    ) -> Result<FanoutSendResult, FanoutFailure> {
        let fanout =
            self.resolve_parts(request.fanout_id.as_deref(), request.worktree_id.as_deref())?;
        Self::reject_while_finalizing(&fanout)?;
        if request.message.trim().is_empty() {
            return Err(failure(
                FanoutFailureCode::InvalidSelector,
                "message is empty",
            ));
        }
        let member_id = match request.target.kind {
            FanoutSendTargetKind::All => None,
            FanoutSendTargetKind::Member => {
                Some(request.target.member_id.clone().ok_or_else(|| {
                    failure(
                        FanoutFailureCode::InvalidSelector,
                        "target `member` needs a memberId",
                    )
                })?)
            }
        };
        let members = select_members(&fanout, member_id.as_deref(), Some(member_id.is_none()))?;
        let message_id = request
            .message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let wait = request.wait_for_delivery.unwrap_or(true);
        let mut receipts = Vec::with_capacity(members.len());
        for member in members {
            let (Some(worktree_id), Some(tab_id)) = (&member.worktree_id, &member.tab_id) else {
                continue;
            };
            let target = DeliveryTarget {
                worktree_id: worktree_id.clone(),
                tab_id: tab_id.clone(),
                runtime_agent_id: member.runtime_agent_id.clone(),
            };
            // A retry of the same message id must not type the follow-up a
            // second time into a member that already took it.
            let key = (message_id.clone(), member.id.clone());
            let state = if self.lock().delivered.contains(&key) {
                FanoutDeliveryState::Delivered
            } else {
                let state = host.deliver_message(&target, &request.message, &message_id, wait);
                if matches!(
                    state,
                    FanoutDeliveryState::Delivered | FanoutDeliveryState::Accepted
                ) {
                    self.lock().delivered.insert(key);
                }
                state
            };
            receipts.push(FanoutDeliveryReceipt {
                member_id: member.id.clone(),
                worktree_id: target.worktree_id,
                tab_id: target.tab_id,
                runtime_agent_id: target.runtime_agent_id,
                message_id: message_id.clone(),
                state,
                error: None,
            });
        }
        Ok(FanoutSendResult {
            fanout_id: fanout.id,
            message_id,
            receipts,
        })
    }

    // -------------------------------------------------------- retry / cancel

    /// Relaunches one member's agent in its existing worktree.
    ///
    /// The worktree is reused deliberately — it may already hold work — and the
    /// old tab id moves into history rather than being dropped, so the record
    /// still explains where earlier output went.
    pub fn retry<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutMemberRequest,
    ) -> Result<FanoutResult, FanoutFailure> {
        let fanout =
            self.resolve_parts(request.fanout_id.as_deref(), request.worktree_id.as_deref())?;
        Self::reject_while_finalizing(&fanout)?;
        let member = find_member(&fanout, &request.member_id)?.clone();
        let parent = host
            .worktree(&fanout.project_id, &fanout.parent_worktree_id)
            .map_err(HostError::into_failure)?;
        if let Some(tab_id) = &member.tab_id {
            host.stop_tab(tab_id);
        }
        self.mutate(&fanout.id, |fanout| {
            if let Some(member) = find_member_mut(fanout, &request.member_id) {
                if let Some(previous) = member.tab_id.take() {
                    member.prior_tab_ids.push(previous);
                }
            }
        });
        let member = self
            .get_by_id(&fanout.id)
            .and_then(|fanout| find_member(&fanout, &request.member_id).ok().cloned())
            .ok_or_else(|| failure(FanoutFailureCode::NotFound, "member disappeared"))?;
        self.provision_member(host, &fanout.id, &member, &parent, &fanout.base_commit);
        self.mutate(&fanout.id, refresh_status);
        self.broadcast();
        self.get_by_id(&fanout.id)
            .map(result_for)
            .ok_or_else(|| failure(FanoutFailureCode::Internal, "fanout disappeared"))
    }

    /// Stops every attempt and releases the parent. Checkouts are left on disk:
    /// cancelling is not the same as discarding work, and the user may still
    /// want what an attempt produced.
    pub fn cancel<H: FanoutHost>(
        &self,
        host: &H,
        reference: &FanoutRef,
    ) -> Result<FanoutResult, FanoutFailure> {
        let fanout = self.resolve(reference)?;
        for member in &fanout.members {
            if let Some(tab_id) = &member.tab_id {
                host.stop_tab(tab_id);
            }
        }
        self.mutate(&fanout.id, |fanout| {
            for member in &mut fanout.members {
                if !matches!(member.status, FanoutMemberStatus::Failed) {
                    member.status = FanoutMemberStatus::Cancelled;
                }
            }
            fanout.status = FanoutStatus::Cancelled;
        });
        self.broadcast();
        self.get_by_id(&fanout.id)
            .map(result_for)
            .ok_or_else(|| failure(FanoutFailureCode::Internal, "fanout disappeared"))
    }

    fn reject_while_finalizing(fanout: &Fanout) -> Result<(), FanoutFailure> {
        if matches!(fanout.status, FanoutStatus::Finalizing) {
            return Err(failure(
                FanoutFailureCode::Conflict,
                "this fanout is finalizing; wait for it to finish or resolve it first",
            ));
        }
        Ok(())
    }

    // ------------------------------------------------------------------ pick

    /// The destructive finalize transaction.
    ///
    /// Ordered so that nothing is destroyed before the work is safe: commit the
    /// winner, merge it, promote its scratchpads, and only then stop sessions
    /// and delete checkouts. Every completed step is persisted as a
    /// [`FanoutFinalizeStage`], so a retry resumes at the first incomplete one
    /// instead of repeating a destructive step.
    // The transaction is one ordered sequence; splitting it across helpers
    // would hide the very ordering that makes it safe.
    #[allow(clippy::too_many_lines)]
    pub fn pick<H: FanoutHost>(
        &self,
        host: &H,
        request: &FanoutMemberRequest,
    ) -> Result<FanoutPickResult, FanoutFailure> {
        let _finalize = self
            .finalize
            .lock()
            .map_err(|_| failure(FanoutFailureCode::Internal, "finalize lock poisoned"))?;
        let fanout =
            self.resolve_parts(request.fanout_id.as_deref(), request.worktree_id.as_deref())?;
        if matches!(fanout.status, FanoutStatus::Completed) {
            return Err(failure(
                FanoutFailureCode::Conflict,
                "this fanout is already finalized",
            ));
        }
        let winner = find_member(&fanout, &request.member_id)?.clone();
        let parent = host
            .worktree(&fanout.project_id, &fanout.parent_worktree_id)
            .map_err(HostError::into_failure)?;
        let mut outcome = PickOutcome::new(&fanout, &winner);

        // Everything up to and including scratchpad promotion is skipped once
        // it is durably recorded. That is what makes a cleanup retry safe: by
        // then the winner's worktree is gone, so re-validating or re-merging it
        // would fail on state this transaction itself removed.
        if resume_at(&fanout, FanoutFinalizeStage::PromotingScratchpads) {
            Self::validate_finalize(host, &fanout, &parent, &winner)?;
            self.set_stage(
                &fanout.id,
                FanoutStatus::Finalizing,
                FanoutFinalizeStage::Validating,
            );

            let winner_worktree = host
                .worktree(
                    &fanout.project_id,
                    winner.worktree_id.as_deref().unwrap_or_default(),
                )
                .map_err(HostError::into_failure)?;

            // 1. Commit the winner's uncommitted work, if any.
            if resume_at(&fanout, FanoutFinalizeStage::CommittingWinner) {
                match Self::commit_winner(host, &winner_worktree) {
                    Ok(commit) => outcome.commit = commit,
                    Err(error) => return Err(self.halt(&fanout.id, error)),
                }
                self.set_stage(
                    &fanout.id,
                    FanoutStatus::Finalizing,
                    FanoutFinalizeStage::CommittingWinner,
                );
            }

            // 2. Merge the winner into the parent.
            if resume_at(&fanout, FanoutFinalizeStage::Merging) {
                if let Err(error) = host.merge_into_parent(&parent, &winner_worktree) {
                    if error.code == FanoutFailureCode::MergeConflict {
                        self.set_stage(
                            &fanout.id,
                            FanoutStatus::NeedsResolution,
                            FanoutFinalizeStage::Merging,
                        );
                        outcome.stage = FanoutFinalizeStage::Merging;
                        outcome.failures.push(error.into_failure());
                        self.broadcast();
                        return Ok(self.finish(&fanout.id, outcome));
                    }
                    return Err(self.halt(&fanout.id, error.into_failure()));
                }
                self.set_stage(
                    &fanout.id,
                    FanoutStatus::Finalizing,
                    FanoutFinalizeStage::Merging,
                );
            }

            // 3. Promote the winner's scratchpads into the parent.
            match Self::promote_scratchpads(host, &winner, &winner_worktree, &parent) {
                Ok(paths) => outcome.promoted = paths,
                Err(error) => return Err(self.halt(&fanout.id, error)),
            }
            self.set_stage(
                &fanout.id,
                FanoutStatus::Finalizing,
                FanoutFinalizeStage::PromotingScratchpads,
            );
        }

        // 4. Only now are the attempts expendable.
        for member in &fanout.members {
            if let Some(tab_id) = &member.tab_id {
                host.stop_tab(tab_id);
            }
        }
        self.set_stage(
            &fanout.id,
            FanoutStatus::Finalizing,
            FanoutFinalizeStage::StoppingSessions,
        );

        // 5. Delete every attempt checkout, the winner included.
        for member in &fanout.members {
            let Some(worktree_id) = &member.worktree_id else {
                continue;
            };
            let Some(worktree) = host.find_worktree(worktree_id) else {
                outcome.deleted.push(worktree_id.clone());
                continue;
            };
            match host.delete_worktree(&worktree) {
                Ok(()) => outcome.deleted.push(worktree_id.clone()),
                Err(error) => {
                    outcome.survivors.push(worktree_id.clone());
                    outcome
                        .failures
                        .push(member_failure(error.code, &member.id, error.message));
                }
            }
        }

        let completed = outcome.survivors.is_empty();
        let (status, stage) = if completed {
            (FanoutStatus::Completed, FanoutFinalizeStage::Completed)
        } else {
            (FanoutStatus::CleanupFailed, FanoutFinalizeStage::CleaningUp)
        };
        outcome.stage = stage;
        let winner_id = winner.id.clone();
        let deleted = outcome.deleted.clone();
        self.mutate(&fanout.id, |fanout| {
            fanout.winning_member_id = Some(winner_id.clone());
            fanout.finalize_stage = Some(stage);
            fanout.status = status;
            for member in &mut fanout.members {
                if member.id == winner_id {
                    member.status = FanoutMemberStatus::Selected;
                }
                if member
                    .worktree_id
                    .as_ref()
                    .is_some_and(|id| deleted.contains(id))
                {
                    member.worktree_id = None;
                    if let Some(tab_id) = member.tab_id.take() {
                        member.prior_tab_ids.push(tab_id);
                    }
                }
            }
        });
        self.broadcast();
        Ok(self.finish(&fanout.id, outcome))
    }

    /// Refuses a finalize that would destroy something the record cannot
    /// account for: a member from another fanout, an attempt that is not a
    /// direct child of the parent, or an attempt that has children of its own.
    fn validate_finalize<H: FanoutHost>(
        host: &H,
        fanout: &Fanout,
        parent: &WorktreeView,
        winner: &FanoutMember,
    ) -> Result<(), FanoutFailure> {
        if winner.worktree_id.is_none() {
            return Err(member_failure(
                FanoutFailureCode::Conflict,
                &winner.id,
                "this attempt has no worktree to merge",
            ));
        }
        for member in &fanout.members {
            let Some(worktree_id) = &member.worktree_id else {
                continue;
            };
            let Some(worktree) = host.find_worktree(worktree_id) else {
                continue;
            };
            if worktree.parent_id.as_deref() != Some(parent.id.as_str()) {
                return Err(member_failure(
                    FanoutFailureCode::Conflict,
                    &member.id,
                    "an attempt is no longer a direct child of the fanout parent",
                ));
            }
            let descendants = host.child_worktree_ids(worktree_id);
            if !descendants.is_empty() {
                return Err(member_failure(
                    FanoutFailureCode::DescendantWorktree,
                    &member.id,
                    "an attempt has its own child worktrees; delete or move them first",
                ));
            }
        }
        Ok(())
    }

    /// Stages and commits the winner's uncommitted work under an AI-generated
    /// message. A missing or failing helper stops finalization — there is no
    /// invented fallback message.
    fn commit_winner<H: FanoutHost>(
        host: &H,
        winner: &WorktreeView,
    ) -> Result<Option<String>, FanoutFailure> {
        if !host
            .is_dirty(&winner.path)
            .map_err(HostError::into_failure)?
        {
            return Ok(None);
        }
        let message = host
            .generate_commit_message(&winner.path)
            .map_err(HostError::into_failure)?;
        if message.trim().is_empty() {
            return Err(failure(
                FanoutFailureCode::CommitMessageFailed,
                "the commit-message helper returned an empty message",
            ));
        }
        host.stage_and_commit(&winner.path, message.trim())
            .map_err(HostError::into_failure)
    }

    /// Copies the winner's scratchpads and their comment threads into the
    /// parent, keeping ids and titles and clearing the agent attachment (the
    /// tab it pointed at is about to be deleted).
    fn promote_scratchpads<H: FanoutHost>(
        host: &H,
        winner: &FanoutMember,
        winner_worktree: &WorktreeView,
        parent: &WorktreeView,
    ) -> Result<Vec<String>, FanoutFailure> {
        let scratchpads = host
            .list_scratchpads(&winner_worktree.path)
            .map_err(HostError::into_failure)?;
        let mut promoted = Vec::with_capacity(scratchpads.len());
        for scratchpad in scratchpads {
            let contents = pragma_core::scratchpads::detach_agent(&scratchpad.contents);
            let existing = host.read_file(&parent.path, &scratchpad.file_path);
            let destination = promotion_path(
                &scratchpad.file_path,
                &winner.id,
                existing.as_deref(),
                &contents,
            );
            host.write_file(&parent.path, &destination, &contents)
                .map_err(HostError::into_failure)?;
            if let Some(comments) = scratchpad.comments {
                host.write_file(
                    &parent.path,
                    &pragma_core::scratchpads::comments_path(&destination),
                    &comments,
                )
                .map_err(HostError::into_failure)?;
            }
            promoted.push(destination);
        }
        Ok(promoted)
    }

    /// Records a finalize failure on the durable record and returns it. The
    /// fanout keeps its stage so a retry resumes rather than restarts.
    fn halt(&self, fanout_id: &str, error: FanoutFailure) -> FanoutFailure {
        let recorded = error.clone();
        self.mutate(fanout_id, |fanout| {
            fanout.failure = Some(recorded.clone());
            fanout.status = FanoutStatus::NeedsResolution;
        });
        self.broadcast();
        error
    }

    fn set_stage(&self, fanout_id: &str, status: FanoutStatus, stage: FanoutFinalizeStage) {
        self.mutate(fanout_id, |fanout| {
            fanout.status = status;
            fanout.finalize_stage = Some(stage);
        });
    }

    fn finish(&self, fanout_id: &str, outcome: PickOutcome) -> FanoutPickResult {
        let fanout = self.get_by_id(fanout_id).unwrap_or(outcome.fanout);
        FanoutPickResult {
            stage: fanout.finalize_stage.unwrap_or(outcome.stage),
            fanout,
            winning_member_id: outcome.winning_member_id,
            commit: outcome.commit,
            promoted_scratchpads: outcome.promoted,
            deleted_worktree_ids: outcome.deleted,
            surviving_worktree_ids: outcome.survivors,
            failures: outcome.failures,
        }
    }

    // ------------------------------------------------------------- internals

    fn fail_member(
        &self,
        fanout_id: &str,
        member_id: &str,
        code: FanoutFailureCode,
        message: &str,
    ) {
        self.mutate(fanout_id, |fanout| {
            if let Some(member) = find_member_mut(fanout, member_id) {
                member.status = FanoutMemberStatus::Failed;
                member.failure = Some(member_failure(code, member_id, message));
            }
            refresh_status(fanout);
        });
    }

    fn mutate(&self, fanout_id: &str, apply: impl FnOnce(&mut Fanout)) {
        let mut state = self.lock();
        let Some(fanout) = state
            .fanouts
            .iter_mut()
            .find(|fanout| fanout.id == fanout_id)
        else {
            return;
        };
        apply(fanout);
        fanout.updated_at = timestamp();
        self.persist_locked(&state);
    }

    fn lock(&self) -> MutexGuard<'_, FanoutState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Writes the record owner-only and atomically: a temporary file beside the
    /// target, flushed, permission-restricted, then renamed over it. A prompt
    /// can carry sensitive code context, so the file is never world-readable
    /// and never half-written.
    fn persist_locked(&self, state: &FanoutState) {
        let path = self.server_dir.join(&CONSTANTS.fanout.state_file);
        let Ok(contents) = serde_json::to_vec_pretty(&state.fanouts) else {
            return;
        };
        let temporary = path.with_extension("json.tmp");
        let write = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = pragma_platform::perms::create_private_file(&temporary)?;
            file.write_all(&contents)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &path)?;
            pragma_platform::perms::restrict_to_owner(&path)
        })();
        if let Err(error) = write {
            let _ = std::fs::remove_file(&temporary);
            eprintln!("failed to persist fanout state: {error}");
        }
    }

    fn broadcast(&self) {
        let payload = payload_value(&self.lock().fanouts);
        let event = EventFrame::Delta {
            subscription: ProtocolEventKind::Fanouts,
            payload,
        };
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }
}

/// One `fanouts` RPC. The action names match the CLI verbs and the SDK methods
/// one for one, so all three speak the same domain.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum FanoutRequest {
    Create(FanoutCreateRequest),
    Get(FanoutRef),
    Read(FanoutReadRequest),
    Send(FanoutSendRequest),
    Retry(FanoutMemberRequest),
    Cancel(FanoutRef),
    Pick(FanoutMemberRequest),
}

/// Dispatches one `fanouts` RPC against the durable store and this host.
///
/// Failures come back as a typed [`FanoutFailure`] so the machine-readable code
/// (and the member or finalize stage it belongs to) survives all the way to the
/// CLI and the SDK.
pub fn handle_rpc<H: FanoutHost>(
    store: &FanoutStore,
    host: &H,
    payload: serde_json::Value,
) -> Result<serde_json::Value, FanoutFailure> {
    let request: FanoutRequest = serde_json::from_value(payload).map_err(|error| {
        failure(
            FanoutFailureCode::InvalidSelector,
            format!("invalid fanout request: {error}"),
        )
    })?;
    match request {
        FanoutRequest::Create(request) => to_value(store.create(host, &request)?),
        FanoutRequest::Get(reference) => to_value(store.resolve(&reference)?),
        FanoutRequest::Read(request) => to_value(store.read(host, &request)?),
        FanoutRequest::Send(request) => to_value(store.send(host, &request)?),
        FanoutRequest::Retry(request) => to_value(store.retry(host, &request)?),
        FanoutRequest::Cancel(reference) => to_value(store.cancel(host, &reference)?),
        FanoutRequest::Pick(request) => to_value(store.pick(host, &request)?),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Result<serde_json::Value, FanoutFailure> {
    serde_json::to_value(value)
        .map_err(|error| failure(FanoutFailureCode::Internal, error.to_string()))
}

/// The protocol-level code a fanout failure surfaces as. The fanout code itself
/// rides along in the error details.
#[must_use]
pub fn protocol_code(code: FanoutFailureCode) -> pragma_constants::ProtocolErrorCode {
    use pragma_constants::ProtocolErrorCode as Protocol;
    match code {
        FanoutFailureCode::NotFound => Protocol::NotFound,
        FanoutFailureCode::InvalidSelector
        | FanoutFailureCode::UnknownAgent
        | FanoutFailureCode::UnknownModel
        | FanoutFailureCode::UnknownReasoning => Protocol::InvalidPayload,
        FanoutFailureCode::ActiveFanoutExists
        | FanoutFailureCode::DirtyParent
        | FanoutFailureCode::Conflict
        | FanoutFailureCode::DescendantWorktree
        | FanoutFailureCode::MergeConflict => Protocol::StaleWrite,
        FanoutFailureCode::WorktreeCreateFailed
        | FanoutFailureCode::SetupFailed
        | FanoutFailureCode::LaunchFailed
        | FanoutFailureCode::CommitMessageFailed
        | FanoutFailureCode::PromotionFailed
        | FanoutFailureCode::CleanupFailed
        | FanoutFailureCode::Internal => Protocol::Internal,
    }
}

/// Default tail size for `fanout read` when the caller names none.
const DEFAULT_READ_LINES: usize = 200;

struct CreatePlan {
    members: Vec<pragma_core::fanout::ResolvedSelector>,
}

struct PickOutcome {
    fanout: Fanout,
    winning_member_id: String,
    stage: FanoutFinalizeStage,
    commit: Option<String>,
    promoted: Vec<String>,
    deleted: Vec<String>,
    survivors: Vec<String>,
    failures: Vec<FanoutFailure>,
}

impl PickOutcome {
    fn new(fanout: &Fanout, winner: &FanoutMember) -> Self {
        Self {
            fanout: fanout.clone(),
            winning_member_id: winner.id.clone(),
            stage: FanoutFinalizeStage::Validating,
            commit: None,
            promoted: Vec::new(),
            deleted: Vec::new(),
            survivors: Vec::new(),
            failures: Vec::new(),
        }
    }
}

/// True when finalization has not yet recorded `stage` as complete.
fn resume_at(fanout: &Fanout, stage: FanoutFinalizeStage) -> bool {
    let Some(current) = fanout.finalize_stage else {
        return true;
    };
    stage_rank(current) < stage_rank(stage)
}

fn stage_rank(stage: FanoutFinalizeStage) -> u8 {
    match stage {
        FanoutFinalizeStage::Validating => 0,
        FanoutFinalizeStage::CommittingWinner => 1,
        FanoutFinalizeStage::Merging => 2,
        FanoutFinalizeStage::PromotingScratchpads => 3,
        FanoutFinalizeStage::StoppingSessions => 4,
        FanoutFinalizeStage::CleaningUp => 5,
        FanoutFinalizeStage::Completed => 6,
    }
}

fn refresh_status(fanout: &mut Fanout) {
    let statuses: Vec<_> = fanout.members.iter().map(|member| member.status).collect();
    fanout.status = aggregate_status(fanout.status, &statuses);
}

fn result_for(fanout: Fanout) -> FanoutResult {
    let failures = fanout
        .members
        .iter()
        .filter_map(|member| member.failure.clone())
        .collect::<Vec<_>>();
    FanoutResult {
        partial: !failures.is_empty()
            && fanout
                .members
                .iter()
                .any(|member| !matches!(member.status, FanoutMemberStatus::Failed)),
        failures,
        fanout,
    }
}

fn find_member<'a>(fanout: &'a Fanout, member_id: &str) -> Result<&'a FanoutMember, FanoutFailure> {
    fanout
        .members
        .iter()
        .find(|member| member.id == member_id)
        .ok_or_else(|| {
            failure(
                FanoutFailureCode::NotFound,
                format!("fanout `{}` has no member `{member_id}`", fanout.id),
            )
        })
}

fn find_member_mut<'a>(fanout: &'a mut Fanout, member_id: &str) -> Option<&'a mut FanoutMember> {
    fanout
        .members
        .iter_mut()
        .find(|member| member.id == member_id)
}

/// One member, or every member that has a live tab.
fn select_members<'a>(
    fanout: &'a Fanout,
    member_id: Option<&str>,
    all: Option<bool>,
) -> Result<Vec<&'a FanoutMember>, FanoutFailure> {
    if let Some(member_id) = member_id {
        return Ok(vec![find_member(fanout, member_id)?]);
    }
    if all == Some(true) {
        return Ok(fanout.members.iter().collect());
    }
    Err(failure(
        FanoutFailureCode::InvalidSelector,
        "pass --member <id> or --all",
    ))
}

fn payload_value(fanouts: &[Fanout]) -> serde_json::Value {
    serde_json::to_value(FanoutSubscriptionPayload {
        fanouts: fanouts.to_vec(),
    })
    .unwrap_or(serde_json::Value::Null)
}

fn member_id() -> String {
    format!("m-{}", &Uuid::new_v4().simple().to_string()[..8])
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Base64 for the raw-bytes field of a read result. Hand-rolled rather than a
/// new dependency: the alphabet is fixed and this is the only encoder the
/// server needs.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests;
