//! Who may use the computer: the `computerUse` settings, the grants the desktop
//! user has given, and the approval prompts that are waiting on them.
//!
//! The configured policy is read from the global `.pragma/config.json` on each
//! check (it is small and the user may change it at any time). Grants are two
//! kinds: "for this session" lives in memory with the session, "always" is
//! persisted to an owner-only file beside the socket. An approval blocks the
//! asking request until the desktop user answers or it times out — an agent
//! can never answer its own prompt, because only the desktop calls `approve`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use pragma_constants::{
    ComputerAccess, ComputerApproval, ComputerApprovalDecision, ComputerCaller, ComputerErrorCode,
    ComputerFailure, ComputerUseSettings, CONSTANTS,
};
use pragma_core::computer::{configured_access, failure, grant_key};

/// Reads the global `computerUse` block. A missing, unreadable, or malformed
/// file reads as "off": computer use is never enabled by accident.
#[must_use]
pub fn load_settings(home: Option<&Path>) -> ComputerUseSettings {
    let Some(home) = home else {
        return ComputerUseSettings::default();
    };
    let Ok(contents) = std::fs::read_to_string(home.join(&CONSTANTS.plugins.config_file_name))
    else {
        return ComputerUseSettings::default();
    };
    serde_json::from_str::<serde_json::Value>(&contents)
        .ok()
        .and_then(|config| config.get("computerUse").cloned())
        .and_then(|block| serde_json::from_value(block).ok())
        .unwrap_or_default()
}

/// The answer an approval resolved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allowed { remember_for_session: bool },
    Denied,
}

struct PendingApproval {
    approval: ComputerApproval,
    decision: Option<ComputerApprovalDecision>,
}

/// Persisted grants plus the prompts waiting for the desktop user.
pub struct Policy {
    grants_path: PathBuf,
    always: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<String, PendingApproval>>,
    answered: Condvar,
}

impl Policy {
    /// Loads persisted grants from `server_dir`.
    pub fn load(server_dir: &Path) -> Self {
        let grants_path = server_dir.join(&CONSTANTS.computer.grants_file);
        let always = std::fs::read_to_string(&grants_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Vec<String>>(&contents).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        Self {
            grants_path,
            always: Mutex::new(always),
            pending: Mutex::new(HashMap::new()),
            answered: Condvar::new(),
        }
    }

    /// The effective access for a caller: the configured policy, raised to
    /// `allow` by an "always" grant. A configured `deny` is never overridden.
    pub fn access(
        &self,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
    ) -> ComputerAccess {
        match configured_access(settings, caller) {
            ComputerAccess::Ask
                if self
                    .always
                    .lock()
                    .is_ok_and(|always| always.contains(&grant_key(caller))) =>
            {
                ComputerAccess::Allow
            }
            other => other,
        }
    }

    /// Pending approvals, oldest first, for the activity snapshot.
    pub fn pending(&self) -> Vec<ComputerApproval> {
        let mut approvals: Vec<ComputerApproval> = self
            .pending
            .lock()
            .map(|pending| {
                pending
                    .values()
                    .filter(|entry| entry.decision.is_none())
                    .map(|entry| entry.approval.clone())
                    .collect()
            })
            .unwrap_or_default();
        approvals.sort_by_key(|approval| approval.requested_at);
        approvals
    }

    /// Files an approval and blocks until it is answered or times out.
    ///
    /// `announce` runs once the approval is registered, so the desktop can
    /// never be told about a prompt `approve` cannot find yet.
    pub fn wait_for(
        &self,
        approval: &ComputerApproval,
        announce: impl FnOnce(&ComputerApproval),
    ) -> Result<Verdict, ComputerFailure> {
        let id = approval.id.clone();
        let caller = approval.caller.clone();
        let timeout = Duration::from_millis(CONSTANTS.computer.approval_timeout_ms.get());
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "approval lock poisoned"))?;
        pending.insert(
            id.clone(),
            PendingApproval {
                approval: approval.clone(),
                decision: None,
            },
        );
        announce(approval);
        let (mut pending, _) = self
            .answered
            .wait_timeout_while(pending, timeout, |pending| {
                pending
                    .get(&id)
                    .is_some_and(|entry| entry.decision.is_none())
            })
            .map_err(|_| failure(ComputerErrorCode::Internal, "approval lock poisoned"))?;
        let decision = pending.remove(&id).and_then(|entry| entry.decision);
        drop(pending);
        match decision {
            Some(ComputerApprovalDecision::Once) => Ok(Verdict::Allowed {
                remember_for_session: false,
            }),
            Some(ComputerApprovalDecision::Session) => Ok(Verdict::Allowed {
                remember_for_session: true,
            }),
            Some(ComputerApprovalDecision::Always) => {
                self.remember_always(&caller);
                Ok(Verdict::Allowed {
                    remember_for_session: true,
                })
            }
            Some(ComputerApprovalDecision::Deny) => Ok(Verdict::Denied),
            None => {
                let mut timed_out = failure(
                    ComputerErrorCode::ApprovalRequired,
                    "nobody answered the approval prompt in Pragma",
                );
                timed_out.hint =
                    Some("Ask the user to allow computer use from the Pragma window.".to_string());
                Err(timed_out)
            }
        }
    }

    /// Answers a pending approval. Returns the approval it answered.
    pub fn answer(
        &self,
        id: &str,
        decision: ComputerApprovalDecision,
    ) -> Result<ComputerApproval, ComputerFailure> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "approval lock poisoned"))?;
        let entry = pending
            .get_mut(id)
            .filter(|entry| entry.decision.is_none())
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::InvalidPayload,
                    format!("no pending approval `{id}`"),
                )
            })?;
        entry.decision = Some(decision);
        let approval = entry.approval.clone();
        drop(pending);
        self.answered.notify_all();
        Ok(approval)
    }

    /// Denies every pending approval (the emergency stop).
    pub fn deny_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for entry in pending.values_mut() {
                entry.decision.get_or_insert(ComputerApprovalDecision::Deny);
            }
        }
        self.answered.notify_all();
    }

    /// Withdraws a cancelled task owner's outstanding prompts.
    pub fn deny_caller(&self, caller: &ComputerCaller) {
        if let Ok(mut pending) = self.pending.lock() {
            for entry in pending.values_mut().filter(|entry| {
                pragma_core::computer::owner_key(&entry.approval.caller)
                    == pragma_core::computer::owner_key(caller)
            }) {
                entry.decision.get_or_insert(ComputerApprovalDecision::Deny);
            }
        }
        self.answered.notify_all();
    }

    fn remember_always(&self, caller: &ComputerCaller) {
        let Ok(mut always) = self.always.lock() else {
            return;
        };
        always.insert(grant_key(caller));
        let mut list: Vec<&String> = always.iter().collect();
        list.sort();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            if let Ok(mut file) = pragma_platform::perms::create_private_file(&self.grants_path) {
                let _ = std::io::Write::write_all(&mut file, json.as_bytes());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use pragma_constants::{ComputerCallerKind, ComputerOp};

    fn caller() -> ComputerCaller {
        ComputerCaller {
            kind: ComputerCallerKind::AgentTab,
            tab_id: Some("t1".to_string()),
            worktree_id: None,
            agent_id: Some("claude-code".to_string()),
            plugin_id: None,
            label: None,
        }
    }

    fn approval(id: &str) -> ComputerApproval {
        ComputerApproval {
            id: id.to_string(),
            caller: caller(),
            session_id: None,
            op: ComputerOp::Click,
            reason: "first use".to_string(),
            sensitive: false,
            target: None,
            requested_at: 0,
            expires_at: 0,
        }
    }

    #[test]
    fn settings_default_off_and_parse() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_settings(Some(dir.path())).enabled, None);
        std::fs::create_dir_all(dir.path().join(".pragma")).unwrap();
        std::fs::write(
            dir.path().join(".pragma/config.json"),
            r#"{"computerUse":{"enabled":true,"access":{"agents":{"*":"allow"}}}}"#,
        )
        .unwrap();
        let settings = load_settings(Some(dir.path()));
        assert_eq!(settings.enabled, Some(true));
        assert_eq!(
            configured_access(&settings, &caller()),
            ComputerAccess::Allow
        );
    }

    #[test]
    fn always_grants_persist_and_raise_ask() {
        let dir = tempfile::tempdir().unwrap();
        let policy = Arc::new(Policy::load(dir.path()));
        let settings = ComputerUseSettings::default();
        assert_eq!(policy.access(&settings, &caller()), ComputerAccess::Ask);
        let waiter = {
            let policy = Arc::clone(&policy);
            std::thread::spawn(move || policy.wait_for(&approval("a1"), |_| {}))
        };
        while policy.pending().is_empty() {
            std::thread::yield_now();
        }
        policy
            .answer("a1", ComputerApprovalDecision::Always)
            .unwrap();
        assert_eq!(
            waiter.join().unwrap().unwrap(),
            Verdict::Allowed {
                remember_for_session: true
            }
        );
        assert_eq!(policy.access(&settings, &caller()), ComputerAccess::Allow);
        let reloaded = Policy::load(dir.path());
        assert_eq!(reloaded.access(&settings, &caller()), ComputerAccess::Allow);
    }

    #[test]
    fn deny_all_releases_waiters() {
        let dir = tempfile::tempdir().unwrap();
        let policy = Arc::new(Policy::load(dir.path()));
        let waiter = {
            let policy = Arc::clone(&policy);
            std::thread::spawn(move || policy.wait_for(&approval("a2"), |_| {}))
        };
        while policy.pending().is_empty() {
            std::thread::yield_now();
        }
        policy.deny_all();
        assert_eq!(waiter.join().unwrap().unwrap(), Verdict::Denied);
        assert!(policy.answer("a2", ComputerApprovalDecision::Once).is_err());
    }
}
