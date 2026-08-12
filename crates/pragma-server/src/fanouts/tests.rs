//! Fanout orchestration tests.
//!
//! Every rule is exercised against [`FakeHost`], an in-memory implementation of
//! the [`FanoutHost`] seam. That keeps the tests deterministic and identical on
//! every platform — no git, no PTYs — while still covering ordering,
//! idempotency, partial failure, restart reconciliation, and the destructive
//! pick transaction end to end.

use std::collections::HashMap;
use std::sync::Mutex;

use pragma_constants::{
    FanoutCreateRequest, FanoutDeliveryState, FanoutExistingParent, FanoutExistingParentKind,
    FanoutFailureCode, FanoutFinalizeStage, FanoutMemberRequest, FanoutMemberSelector,
    FanoutMemberStatus, FanoutNewParent, FanoutNewParentKind, FanoutParentSpec, FanoutReadRequest,
    FanoutRef, FanoutSendRequest, FanoutSendTarget, FanoutSendTargetKind, FanoutStatus,
};
use pragma_core::fanout::{CatalogAgentView, CatalogModelView};

use super::{
    DeliveryTarget, FanoutHost, FanoutStore, HostError, HostResult, LaunchSpec, ScratchpadCopy,
    WorktreeView,
};

// ------------------------------------------------------------------ fake host

struct FakeState {
    worktrees: Vec<WorktreeView>,
    dirty: Vec<String>,
    heads: HashMap<String, String>,
    files: HashMap<(String, String), String>,
    scratchpads: HashMap<String, Vec<ScratchpadCopy>>,
    launches: Vec<LaunchSpec>,
    deliveries: Vec<(DeliveryTarget, String, String)>,
    stopped: Vec<String>,
    deleted: Vec<String>,
    commits: Vec<(String, String)>,
    next_tab: usize,
    next_worktree: usize,
    fail_launch_for: Option<String>,
    fail_worktree_for: Option<String>,
    fail_delete_for: Option<String>,
    merge_conflict: bool,
    commit_message: Result<String, String>,
    undeliverable: bool,
}

impl Default for FakeState {
    fn default() -> Self {
        Self {
            worktrees: Vec::new(),
            dirty: Vec::new(),
            heads: HashMap::new(),
            files: HashMap::new(),
            scratchpads: HashMap::new(),
            launches: Vec::new(),
            deliveries: Vec::new(),
            stopped: Vec::new(),
            deleted: Vec::new(),
            commits: Vec::new(),
            next_tab: 0,
            next_worktree: 0,
            fail_launch_for: None,
            fail_worktree_for: None,
            fail_delete_for: None,
            merge_conflict: false,
            commit_message: Ok("feat: add token refresh".to_string()),
            undeliverable: false,
        }
    }
}

struct FakeHost {
    state: Mutex<FakeState>,
    catalog: Vec<CatalogAgentView>,
}

impl FakeHost {
    fn new() -> Self {
        let mut state = FakeState {
            commit_message: Ok("feat: add token refresh".to_string()),
            ..FakeState::default()
        };
        state.worktrees.push(WorktreeView {
            id: "wt-main".to_string(),
            project_id: "p1".to_string(),
            parent_id: None,
            branch: "main".to_string(),
            path: "/repo/main".to_string(),
        });
        state
            .heads
            .insert("/repo/main".to_string(), "aaaa1111".to_string());
        Self {
            state: Mutex::new(state),
            catalog: vec![
                CatalogAgentView {
                    id: "pragma.opencode".to_string(),
                    runtime_agent_id: "opencode".to_string(),
                    models: vec![CatalogModelView {
                        id: "gpt".to_string(),
                        reasoning_ids: vec!["high".to_string()],
                    }],
                },
                CatalogAgentView {
                    id: "pragma.claude-code".to_string(),
                    runtime_agent_id: "claude-code".to_string(),
                    models: vec![CatalogModelView {
                        id: "opus".to_string(),
                        reasoning_ids: vec!["high".to_string(), "max".to_string()],
                    }],
                },
            ],
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().expect("fake host lock")
    }

    fn mark_dirty(&self, path: &str) {
        self.state().dirty.push(path.to_string());
    }
}

impl FanoutHost for FakeHost {
    fn project_root(&self, project_id: &str) -> HostResult<String> {
        if project_id == "p1" {
            Ok("/repo".to_string())
        } else {
            Err(HostError::new(FanoutFailureCode::NotFound, "no project"))
        }
    }

    fn worktree(&self, project_id: &str, worktree_id: &str) -> HostResult<WorktreeView> {
        self.state()
            .worktrees
            .iter()
            .find(|worktree| worktree.id == worktree_id && worktree.project_id == project_id)
            .cloned()
            .ok_or_else(|| HostError::new(FanoutFailureCode::NotFound, "no worktree"))
    }

    fn find_worktree(&self, worktree_id: &str) -> Option<WorktreeView> {
        self.state()
            .worktrees
            .iter()
            .find(|worktree| worktree.id == worktree_id)
            .cloned()
    }

    fn child_worktree_ids(&self, worktree_id: &str) -> Vec<String> {
        self.state()
            .worktrees
            .iter()
            .filter(|worktree| worktree.parent_id.as_deref() == Some(worktree_id))
            .map(|worktree| worktree.id.clone())
            .collect()
    }

    fn catalog(&self, _project_root: &str) -> HostResult<Vec<CatalogAgentView>> {
        Ok(self.catalog.clone())
    }

    fn head_commit(&self, root: &str) -> HostResult<String> {
        self.state()
            .heads
            .get(root)
            .cloned()
            .ok_or_else(|| HostError::new(FanoutFailureCode::NotFound, "no head"))
    }

    fn is_dirty(&self, root: &str) -> HostResult<bool> {
        Ok(self.state().dirty.iter().any(|path| path == root))
    }

    fn create_worktree(
        &self,
        project_id: &str,
        parent_worktree_id: &str,
        branch: &str,
        commit: &str,
        _title: Option<&str>,
    ) -> HostResult<WorktreeView> {
        let mut state = self.state();
        if state
            .fail_worktree_for
            .as_deref()
            .is_some_and(|failing| branch.ends_with(failing))
        {
            return Err(HostError::new(
                FanoutFailureCode::WorktreeCreateFailed,
                "checkout refused",
            ));
        }
        state.next_worktree += 1;
        let id = format!("wt-{}", state.next_worktree);
        let path = format!("/repo/{id}");
        let worktree = WorktreeView {
            id: id.clone(),
            project_id: project_id.to_string(),
            parent_id: Some(parent_worktree_id.to_string()),
            branch: branch.to_string(),
            path: path.clone(),
        };
        state.worktrees.push(worktree.clone());
        state.heads.insert(path, commit.to_string());
        Ok(worktree)
    }

    fn launch_agent(&self, spec: &LaunchSpec) -> HostResult<String> {
        let mut state = self.state();
        if state
            .fail_launch_for
            .as_deref()
            .is_some_and(|agent| agent == spec.catalog_agent_id)
        {
            return Err(HostError::new(
                FanoutFailureCode::LaunchFailed,
                "agent would not start",
            ));
        }
        state.next_tab += 1;
        let tab = format!("tab-{}", state.next_tab);
        state.launches.push(spec.clone());
        Ok(tab)
    }

    fn read_tab(&self, tab_id: &str, _lines: usize) -> HostResult<(Vec<u8>, String)> {
        Ok((
            format!("output of {tab_id}").into_bytes(),
            format!("output of {tab_id}"),
        ))
    }

    fn deliver_message(
        &self,
        target: &DeliveryTarget,
        message: &str,
        message_id: &str,
        _wait: bool,
    ) -> FanoutDeliveryState {
        let mut state = self.state();
        if state.undeliverable {
            return FanoutDeliveryState::TimedOut;
        }
        state
            .deliveries
            .push((target.clone(), message.to_string(), message_id.to_string()));
        FanoutDeliveryState::Delivered
    }

    fn stop_tab(&self, tab_id: &str) {
        self.state().stopped.push(tab_id.to_string());
    }

    fn generate_commit_message(&self, _root: &str) -> HostResult<String> {
        self.state()
            .commit_message
            .clone()
            .map_err(|message| HostError::new(FanoutFailureCode::CommitMessageFailed, message))
    }

    fn stage_and_commit(&self, root: &str, message: &str) -> HostResult<Option<String>> {
        let mut state = self.state();
        state.dirty.retain(|path| path != root);
        state.commits.push((root.to_string(), message.to_string()));
        Ok(Some("cccc3333".to_string()))
    }

    fn merge_into_parent(&self, _parent: &WorktreeView, _child: &WorktreeView) -> HostResult<()> {
        if self.state().merge_conflict {
            return Err(HostError::new(
                FanoutFailureCode::MergeConflict,
                "conflicts in src/auth.ts",
            ));
        }
        Ok(())
    }

    fn list_scratchpads(&self, root: &str) -> HostResult<Vec<ScratchpadCopy>> {
        Ok(self
            .state()
            .scratchpads
            .get(root)
            .cloned()
            .unwrap_or_default())
    }

    fn read_file(&self, root: &str, path: &str) -> Option<String> {
        self.state()
            .files
            .get(&(root.to_string(), path.to_string()))
            .cloned()
    }

    fn write_file(&self, root: &str, path: &str, contents: &str) -> HostResult<()> {
        self.state()
            .files
            .insert((root.to_string(), path.to_string()), contents.to_string());
        Ok(())
    }

    fn delete_worktree(&self, worktree: &WorktreeView) -> HostResult<()> {
        let mut state = self.state();
        if state
            .fail_delete_for
            .as_deref()
            .is_some_and(|id| id == worktree.id)
        {
            return Err(HostError::new(
                FanoutFailureCode::CleanupFailed,
                "checkout is locked",
            ));
        }
        state.deleted.push(worktree.id.clone());
        state
            .worktrees
            .retain(|existing| existing.id != worktree.id);
        Ok(())
    }
}

// -------------------------------------------------------------------- helpers

fn store() -> (FanoutStore, tempfile::TempDir) {
    let directory = tempfile::tempdir().expect("temp dir");
    (FanoutStore::load(directory.path()), directory)
}

fn request(selectors: &[&str]) -> FanoutCreateRequest {
    FanoutCreateRequest {
        project_id: "p1".to_string(),
        parent: FanoutParentSpec::ExistingParent(FanoutExistingParent {
            kind: FanoutExistingParentKind::Existing,
            worktree_id: "wt-main".to_string(),
        }),
        prompt: "Implement token refresh and tests".to_string(),
        title: None,
        default_reasoning_id: None,
        members: selectors
            .iter()
            .map(|selector| FanoutMemberSelector {
                selector: (*selector).to_string(),
                model_id: None,
                reasoning_id: None,
            })
            .collect(),
        jobs: None,
        idempotency_key: None,
    }
}

fn two_members() -> FanoutCreateRequest {
    request(&["pragma.opencode", "pragma.claude-code"])
}

// ---------------------------------------------------------------------- tests

#[test]
fn creates_one_attempt_per_selector_from_one_captured_commit() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let result = store.create(&host, &two_members()).expect("creates");

    assert_eq!(result.fanout.members.len(), 2);
    assert_eq!(result.fanout.base_commit, "aaaa1111");
    assert_eq!(result.fanout.status, FanoutStatus::Active);
    assert!(!result.partial);
    assert_eq!(result.fanout.title, "Implement token refresh and tests");
    for member in &result.fanout.members {
        assert!(member.worktree_id.is_some());
        assert!(member.tab_id.is_some());
        assert_eq!(member.status, FanoutMemberStatus::Running);
    }
    let launches = host.state().launches.clone();
    assert_eq!(launches.len(), 2);
    // Every attempt gets the same prompt and its own member identity.
    assert!(launches
        .iter()
        .all(|launch| launch.prompt == "Implement token refresh and tests"));
    assert_ne!(launches[0].member_id, launches[1].member_id);
    // Runtime ids come from the catalog, never derived from the dotted id.
    assert_eq!(launches[0].runtime_agent_id, "opencode");
    assert_eq!(launches[1].runtime_agent_id, "claude-code");
    // Both attempts branch from the captured commit, not from a later HEAD.
    let heads = host.state().heads.clone();
    for member in &result.fanout.members {
        let worktree = host
            .find_worktree(member.worktree_id.as_deref().expect("worktree"))
            .expect("worktree exists");
        assert_eq!(
            heads.get(&worktree.path).map(String::as_str),
            Some("aaaa1111")
        );
        assert_eq!(worktree.parent_id.as_deref(), Some("wt-main"));
    }
}

#[test]
fn duplicate_selectors_are_allowed_and_stay_distinct_members() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let result = store
        .create(&host, &request(&["pragma.opencode", "pragma.opencode"]))
        .expect("creates");
    assert_eq!(result.fanout.members.len(), 2);
    assert_ne!(result.fanout.members[0].id, result.fanout.members[1].id);
    assert_ne!(
        result.fanout.members[0].worktree_id,
        result.fanout.members[1].worktree_id
    );
}

#[test]
fn a_bad_selector_creates_nothing_at_all() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let error = store
        .create(&host, &request(&["pragma.opencode", "pragma.nope"]))
        .expect_err("rejects");
    assert_eq!(error.code, FanoutFailureCode::UnknownAgent);
    assert!(store.all().is_empty());
    assert!(host.state().worktrees.len() == 1);
    assert!(host.state().launches.is_empty());
}

#[test]
fn a_shared_reasoning_no_model_offers_rejects_the_whole_create() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let mut request = two_members();
    request.default_reasoning_id = Some("max".to_string());
    let error = store.create(&host, &request).expect_err("rejects");
    assert_eq!(error.code, FanoutFailureCode::UnknownReasoning);
    assert!(store.all().is_empty());
    assert!(host.state().launches.is_empty());
}

#[test]
fn fewer_than_two_attempts_is_not_a_fanout() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let error = store
        .create(&host, &request(&["pragma.opencode"]))
        .expect_err("rejects");
    assert_eq!(error.code, FanoutFailureCode::InvalidSelector);
}

#[test]
fn a_parent_may_own_only_one_active_fanout() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    store.create(&host, &two_members()).expect("first");
    let error = store.create(&host, &two_members()).expect_err("rejects");
    assert_eq!(error.code, FanoutFailureCode::ActiveFanoutExists);

    // Cancelling releases the parent.
    let fanout = store.all()[0].clone();
    store
        .cancel(
            &host,
            &FanoutRef {
                fanout_id: Some(fanout.id),
                worktree_id: None,
            },
        )
        .expect("cancels");
    store.create(&host, &two_members()).expect("second");
}

#[test]
fn a_dirty_parent_is_refused_because_attempts_inherit_commits_not_bytes() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    host.mark_dirty("/repo/main");
    let error = store.create(&host, &two_members()).expect_err("rejects");
    assert_eq!(error.code, FanoutFailureCode::DirtyParent);
    assert!(store.all().is_empty());
}

#[test]
fn a_new_parent_is_created_from_the_source_worktree_and_owns_it() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let mut request = two_members();
    request.parent = FanoutParentSpec::NewParent(FanoutNewParent {
        kind: FanoutNewParentKind::New,
        source_worktree_id: "wt-main".to_string(),
        branch: "fanout/token-refresh".to_string(),
        title: Some("Token refresh candidates".to_string()),
    });
    let result = store.create(&host, &request).expect("creates");
    assert!(result.fanout.owns_parent);
    assert_eq!(result.fanout.source_worktree_id.as_deref(), Some("wt-main"));
    assert_ne!(result.fanout.parent_worktree_id, "wt-main");
    let parent = host
        .find_worktree(&result.fanout.parent_worktree_id)
        .expect("parent exists");
    assert_eq!(parent.branch, "fanout/token-refresh");
    // Attempts hang off the new parent, not the source.
    for member in &result.fanout.members {
        let worktree = host
            .find_worktree(member.worktree_id.as_deref().expect("worktree"))
            .expect("attempt exists");
        assert_eq!(worktree.parent_id.as_deref(), Some(parent.id.as_str()));
    }
}

#[test]
fn one_failed_member_leaves_the_healthy_ones_alone_and_stays_retryable() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    host.state().fail_launch_for = Some("pragma.claude-code".to_string());
    let result = store.create(&host, &two_members()).expect("creates");

    assert!(result.partial);
    assert_eq!(result.fanout.status, FanoutStatus::Partial);
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].code, FanoutFailureCode::LaunchFailed);
    let healthy = &result.fanout.members[0];
    assert_eq!(healthy.status, FanoutMemberStatus::Running);
    assert!(healthy.tab_id.is_some());

    // Retry relaunches in the same worktree and files the old tab in history.
    host.state().fail_launch_for = None;
    let failed = result.fanout.members[1].clone();
    let worktree_before = failed.worktree_id.clone();
    let retried = store
        .retry(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(result.fanout.id.clone()),
                worktree_id: None,
                member_id: failed.id.clone(),
            },
        )
        .expect("retries");
    let member = retried
        .fanout
        .members
        .iter()
        .find(|member| member.id == failed.id)
        .expect("member");
    assert_eq!(member.status, FanoutMemberStatus::Running);
    assert_eq!(member.worktree_id, worktree_before);
    assert!(member.tab_id.is_some());
    assert_eq!(retried.fanout.status, FanoutStatus::Active);
}

#[test]
fn a_retry_moves_the_previous_tab_into_history_and_stops_it() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates");
    let member = created.fanout.members[0].clone();
    let first_tab = member.tab_id.clone().expect("tab");

    let retried = store
        .retry(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.fanout.id.clone()),
                worktree_id: None,
                member_id: member.id.clone(),
            },
        )
        .expect("retries");
    let updated = retried
        .fanout
        .members
        .iter()
        .find(|candidate| candidate.id == member.id)
        .expect("member");
    assert_eq!(updated.prior_tab_ids, vec![first_tab.clone()]);
    assert_ne!(updated.tab_id.as_ref(), Some(&first_tab));
    assert!(host.state().stopped.contains(&first_tab));
}

#[test]
fn an_idempotency_key_returns_the_same_fanout_instead_of_a_second_one() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let mut request = two_members();
    request.idempotency_key = Some("cli-retry-1".to_string());
    let first = store.create(&host, &request).expect("first");
    let second = store.create(&host, &request).expect("second");
    assert_eq!(first.fanout.id, second.fanout.id);
    assert_eq!(store.all().len(), 1);
    assert_eq!(host.state().launches.len(), 2);
}

#[test]
fn state_persists_owner_only_and_reloads_across_a_restart() {
    let directory = tempfile::tempdir().expect("temp dir");
    let host = FakeHost::new();
    let created = {
        let store = FanoutStore::load(directory.path());
        store.create(&host, &two_members()).expect("creates").fanout
    };

    let path = directory
        .path()
        .join(&pragma_constants::CONSTANTS.fanout.state_file);
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "fanout state must be owner-only");
    }

    // A restart marks live members interrupted rather than replaying prompts.
    let reloaded = FanoutStore::load(directory.path());
    reloaded.reconcile_after_restart();
    let fanout = reloaded.get_by_id(&created.id).expect("survives restart");
    assert_eq!(fanout.status, FanoutStatus::Interrupted);
    assert!(fanout
        .members
        .iter()
        .all(|member| member.status == FanoutMemberStatus::Interrupted));
    assert_eq!(host.state().launches.len(), 2, "no prompt was replayed");
}

#[test]
fn a_corrupt_state_file_starts_empty_rather_than_refusing_to_serve() {
    let directory = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        directory
            .path()
            .join(&pragma_constants::CONSTANTS.fanout.state_file),
        "{ not json",
    )
    .expect("write corrupt");
    let store = FanoutStore::load(directory.path());
    assert!(store.all().is_empty());
}

#[test]
fn a_fanout_resolves_from_its_parent_and_from_any_attempt_worktree() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;

    let from_parent = store
        .resolve(&FanoutRef {
            fanout_id: None,
            worktree_id: Some("wt-main".to_string()),
        })
        .expect("parent resolves");
    assert_eq!(from_parent.id, created.id);

    let attempt = created.members[1].worktree_id.clone().expect("worktree");
    let from_attempt = store
        .resolve(&FanoutRef {
            fanout_id: None,
            worktree_id: Some(attempt),
        })
        .expect("attempt resolves");
    assert_eq!(from_attempt.id, created.id);

    let missing = store
        .resolve(&FanoutRef {
            fanout_id: None,
            worktree_id: Some("wt-unrelated".to_string()),
        })
        .expect_err("unknown worktree");
    assert_eq!(missing.code, FanoutFailureCode::NotFound);
}

#[test]
fn read_returns_per_member_identity_and_both_text_and_raw_bytes() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let result = store
        .read(
            &host,
            &FanoutReadRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: None,
                all: Some(true),
                lines: std::num::NonZeroU64::new(50),
            },
        )
        .expect("reads");
    assert_eq!(result.targets.len(), 2);
    let first = &result.targets[0];
    assert_eq!(first.member_id, created.members[0].id);
    assert_eq!(first.runtime_agent_id, "opencode");
    assert!(first.text.starts_with("output of tab-"));
    // The raw field is base64 of the same window.
    assert_eq!(
        first.data,
        super::base64_encode(first.text.as_bytes()),
        "raw bytes ride the wire as base64"
    );
}

#[test]
fn send_scopes_each_delivery_to_one_exact_session_and_dedupes_by_message_id() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let send = FanoutSendRequest {
        fanout_id: Some(created.id.clone()),
        worktree_id: None,
        target: FanoutSendTarget {
            kind: FanoutSendTargetKind::All,
            member_id: None,
        },
        message: "Also include migration docs".to_string(),
        message_id: Some("msg-1".to_string()),
        wait_for_delivery: Some(true),
    };
    let result = store.send(&host, &send).expect("sends");
    assert_eq!(result.receipts.len(), 2);
    assert!(result
        .receipts
        .iter()
        .all(|receipt| receipt.state == FanoutDeliveryState::Delivered));
    // Every delivery names one exact (worktree, tab, runtime agent) triple.
    let deliveries = host.state().deliveries.clone();
    assert_eq!(deliveries.len(), 2);
    for (target, _, _) in &deliveries {
        let member = created
            .members
            .iter()
            .find(|member| member.tab_id.as_deref() == Some(target.tab_id.as_str()))
            .expect("targets a member tab");
        assert_eq!(
            member.worktree_id.as_deref(),
            Some(target.worktree_id.as_str())
        );
        assert_eq!(member.runtime_agent_id, target.runtime_agent_id);
    }

    // Retrying the same message id does not type it twice.
    let repeat = store.send(&host, &send).expect("re-sends");
    assert!(repeat
        .receipts
        .iter()
        .all(|receipt| receipt.state == FanoutDeliveryState::Delivered));
    assert_eq!(host.state().deliveries.len(), 2);
}

#[test]
fn send_targets_one_member_and_reports_a_timeout_per_target() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    host.state().undeliverable = true;
    let result = store
        .send(
            &host,
            &FanoutSendRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                target: FanoutSendTarget {
                    kind: FanoutSendTargetKind::Member,
                    member_id: Some(created.members[0].id.clone()),
                },
                message: "ping".to_string(),
                message_id: None,
                wait_for_delivery: Some(true),
            },
        )
        .expect("sends");
    assert_eq!(result.receipts.len(), 1);
    assert_eq!(result.receipts[0].state, FanoutDeliveryState::TimedOut);
    assert_eq!(result.receipts[0].member_id, created.members[0].id);
}

#[test]
fn agent_status_reports_move_the_member_and_roll_up_to_the_fanout() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let tabs: Vec<String> = created
        .members
        .iter()
        .filter_map(|member| member.tab_id.clone())
        .collect();

    store.apply_agent_status(&tabs[0], FanoutMemberStatus::Attention);
    assert_eq!(
        store.get_by_id(&created.id).expect("fanout").status,
        FanoutStatus::Attention
    );

    store.apply_agent_status(&tabs[0], FanoutMemberStatus::Done);
    store.apply_agent_status(&tabs[1], FanoutMemberStatus::Done);
    assert_eq!(
        store.get_by_id(&created.id).expect("fanout").status,
        FanoutStatus::Ready
    );
}

#[test]
fn pick_commits_merges_promotes_then_deletes_every_attempt() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let winner = created.members[0].clone();
    let winner_root = format!("/repo/{}", winner.worktree_id.clone().expect("worktree"));
    host.mark_dirty(&winner_root);
    host.state().scratchpads.insert(
        winner_root.clone(),
        vec![ScratchpadCopy {
            file_path: ".pragma/scratchpads/plan.mdx".to_string(),
            contents: "---\npragmaScratchpad: {\"version\":1,\"id\":\"s1\",\"title\":\"Plan\",\"agentTabId\":\"tab-1\",\"agentId\":\"pragma.opencode\"}\n---\nbody\n".to_string(),
            comments: Some("[]".to_string()),
        }],
    );

    let result = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: winner.id.clone(),
            },
        )
        .expect("picks");

    assert_eq!(result.stage, FanoutFinalizeStage::Completed);
    assert_eq!(result.fanout.status, FanoutStatus::Completed);
    assert_eq!(result.winning_member_id, winner.id);
    assert_eq!(result.commit.as_deref(), Some("cccc3333"));
    assert_eq!(
        result.promoted_scratchpads,
        vec![".pragma/scratchpads/plan.mdx".to_string()]
    );
    assert!(result.surviving_worktree_ids.is_empty());
    assert_eq!(
        result.deleted_worktree_ids.len(),
        2,
        "the winner is deleted too"
    );

    // The commit message came from the helper, never a fabricated fallback.
    assert_eq!(
        host.state().commits,
        vec![(winner_root.clone(), "feat: add token refresh".to_string())]
    );
    // The promoted copy no longer points at a tab that is about to vanish.
    let promoted = host
        .read_file("/repo/main", ".pragma/scratchpads/plan.mdx")
        .expect("promoted");
    assert!(promoted.contains("\"agentTabId\":null"));
    assert!(promoted.contains("\"id\":\"s1\""));
    assert!(host
        .read_file("/repo/main", ".pragma/scratchpads/plan.mdx.comments.json")
        .is_some());
    // Sessions stopped only after the work was safe.
    assert_eq!(host.state().stopped.len(), 2);
    // The parent survives.
    assert!(host.find_worktree("wt-main").is_some());
}

#[test]
fn a_clean_winner_is_merged_without_inventing_a_commit() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let result = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect("picks");
    assert!(result.commit.is_none());
    assert!(host.state().commits.is_empty());
    assert_eq!(result.fanout.status, FanoutStatus::Completed);
}

#[test]
fn a_failing_commit_message_helper_stops_finalization_and_keeps_every_attempt() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let winner = created.members[0].clone();
    host.mark_dirty(&format!(
        "/repo/{}",
        winner.worktree_id.clone().expect("wt")
    ));
    host.state().commit_message = Err("pragma-ai is not configured".to_string());

    let error = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: winner.id.clone(),
            },
        )
        .expect_err("stops");
    assert_eq!(error.code, FanoutFailureCode::CommitMessageFailed);
    assert!(error.message.contains("pragma-ai"));
    assert!(host.state().deleted.is_empty(), "no attempt was deleted");
    assert!(host.state().stopped.is_empty(), "no session was stopped");
    let fanout = store.get_by_id(&created.id).expect("fanout");
    assert_eq!(fanout.status, FanoutStatus::NeedsResolution);
    assert_eq!(fanout.members.len(), 2);
}

#[test]
fn a_merge_conflict_keeps_every_attempt_and_promotes_nothing() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    host.state().merge_conflict = true;
    let winner_root = format!(
        "/repo/{}",
        created.members[0].worktree_id.clone().expect("wt")
    );
    host.state().scratchpads.insert(
        winner_root,
        vec![ScratchpadCopy {
            file_path: ".pragma/scratchpads/plan.mdx".to_string(),
            contents: "body".to_string(),
            comments: None,
        }],
    );

    let result = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect("returns a resumable result");

    assert_eq!(result.stage, FanoutFinalizeStage::Merging);
    assert_eq!(result.fanout.status, FanoutStatus::NeedsResolution);
    assert!(result.promoted_scratchpads.is_empty());
    assert!(result.deleted_worktree_ids.is_empty());
    assert!(host.state().stopped.is_empty());
    assert!(host
        .read_file("/repo/main", ".pragma/scratchpads/plan.mdx")
        .is_none());
    assert_eq!(result.failures[0].code, FanoutFailureCode::MergeConflict);

    // Resolving the conflict and retrying resumes past the merge.
    host.state().merge_conflict = false;
    let resumed = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect("resumes");
    assert_eq!(resumed.stage, FanoutFinalizeStage::Completed);
    assert_eq!(resumed.promoted_scratchpads.len(), 1);
}

#[test]
fn a_scratchpad_name_collision_keeps_both_documents() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let winner = created.members[0].clone();
    host.write_file(
        "/repo/main",
        ".pragma/scratchpads/plan.mdx",
        "parent version",
    )
    .expect("seed parent");
    host.state().scratchpads.insert(
        format!("/repo/{}", winner.worktree_id.clone().expect("wt")),
        vec![ScratchpadCopy {
            file_path: ".pragma/scratchpads/plan.mdx".to_string(),
            contents: "attempt version".to_string(),
            comments: None,
        }],
    );

    let result = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: winner.id.clone(),
            },
        )
        .expect("picks");
    let promoted = &result.promoted_scratchpads[0];
    assert_ne!(promoted, ".pragma/scratchpads/plan.mdx");
    assert!(std::path::Path::new(promoted)
        .extension()
        .is_some_and(|ext| ext == "mdx"));
    assert_eq!(
        host.read_file("/repo/main", ".pragma/scratchpads/plan.mdx")
            .as_deref(),
        Some("parent version"),
        "the parent's own document is never overwritten"
    );
}

#[test]
fn finalize_refuses_while_an_attempt_still_has_a_child_worktree() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let attempt = created.members[1].worktree_id.clone().expect("worktree");
    host.state().worktrees.push(WorktreeView {
        id: "wt-child".to_string(),
        project_id: "p1".to_string(),
        parent_id: Some(attempt),
        branch: "child".to_string(),
        path: "/repo/wt-child".to_string(),
    });

    let error = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect_err("refuses");
    assert_eq!(error.code, FanoutFailureCode::DescendantWorktree);
    assert!(host.state().deleted.is_empty());
}

#[test]
fn partial_cleanup_records_the_survivor_and_never_reports_completed() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let stubborn = created.members[1].worktree_id.clone().expect("worktree");
    host.state().fail_delete_for = Some(stubborn.clone());

    let result = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect("picks");
    assert_eq!(result.stage, FanoutFinalizeStage::CleaningUp);
    assert_eq!(result.fanout.status, FanoutStatus::CleanupFailed);
    assert_eq!(result.surviving_worktree_ids, vec![stubborn.clone()]);
    assert_eq!(result.deleted_worktree_ids.len(), 1);

    // Retrying cleans up only what is left.
    host.state().fail_delete_for = None;
    let retried = store
        .pick(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect("retries cleanup");
    assert_eq!(retried.fanout.status, FanoutStatus::Completed);
    assert!(retried.surviving_worktree_ids.is_empty());
}

#[test]
fn sends_and_retries_are_frozen_while_a_fanout_is_finalizing() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let created = store.create(&host, &two_members()).expect("creates").fanout;
    store.set_stage(
        &created.id,
        FanoutStatus::Finalizing,
        FanoutFinalizeStage::Merging,
    );

    let send = store
        .send(
            &host,
            &FanoutSendRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                target: FanoutSendTarget {
                    kind: FanoutSendTargetKind::All,
                    member_id: None,
                },
                message: "hello".to_string(),
                message_id: None,
                wait_for_delivery: Some(false),
            },
        )
        .expect_err("frozen");
    assert_eq!(send.code, FanoutFailureCode::Conflict);

    let retry = store
        .retry(
            &host,
            &FanoutMemberRequest {
                fanout_id: Some(created.id.clone()),
                worktree_id: None,
                member_id: created.members[0].id.clone(),
            },
        )
        .expect_err("frozen");
    assert_eq!(retry.code, FanoutFailureCode::Conflict);
}

#[test]
fn a_subscription_gets_a_snapshot_then_full_replacement_deltas() {
    let (store, _dir) = store();
    let host = FakeHost::new();
    let (snapshot, events) = store.subscribe();
    assert_eq!(snapshot.len(), 1);
    match &snapshot[0] {
        pragma_protocol::EventFrame::Snapshot { payload, .. } => {
            assert_eq!(payload["fanouts"].as_array().map(Vec::len), Some(0));
        }
        _ => panic!("expected a snapshot frame"),
    }

    let created = store.create(&host, &two_members()).expect("creates").fanout;
    let mut last = None;
    while let Ok(event) = events.try_recv() {
        last = Some(event);
    }
    match last.expect("at least one delta") {
        pragma_protocol::EventFrame::Delta { payload, .. } => {
            let fanouts = payload["fanouts"].as_array().expect("array");
            assert_eq!(fanouts.len(), 1);
            assert_eq!(fanouts[0]["id"], created.id);
        }
        _ => panic!("expected a delta frame"),
    }
}
