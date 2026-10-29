//! Live computer-use sessions, their exclusive app leases, and the short input
//! mutex that serializes anything moving the physical cursor or keyboard.
//!
//! One session per owner (an agent tab, a plugin, the SDK). A session holds
//! the leases of every app it has acted on until it ends; the input mutex is
//! held only for the length of one action, so two agents in two different
//! apps interleave rather than wait on each other's whole session.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use pragma_constants::{
    ComputerCaller, ComputerErrorCode, ComputerFailure, ComputerLease, ComputerPauseReason,
    ComputerSession, CONSTANTS,
};
use pragma_core::computer::{caller_label, failure, owner_key, LeaseOutcome, LeaseTable};

/// Sessions and leases, behind one lock so a lease and its session never
/// disagree.
#[derive(Default)]
pub struct Sessions {
    by_owner: HashMap<String, ComputerSession>,
    leases: LeaseTable,
}

impl Sessions {
    /// The caller's session, created on first use. Returns it and whether it
    /// is new.
    pub fn open(&mut self, caller: &ComputerCaller, now: u64) -> (ComputerSession, bool) {
        let key = owner_key(caller);
        if let Some(session) = self.by_owner.get(&key) {
            return (session.clone(), false);
        }
        let mut owner = caller.clone();
        owner.label.get_or_insert_with(|| caller_label(caller));
        let session = ComputerSession {
            id: format!("cs_{}", uuid::Uuid::new_v4().simple()),
            worktree_id: caller.worktree_id.clone(),
            owner,
            leases: Vec::new(),
            started_at: now,
            last_action_at: now,
            action_count: 0,
            paused: false,
            pause_reason: None,
            last_description: None,
        };
        self.by_owner.insert(key, session.clone());
        (session, true)
    }

    /// The caller's session, if one is live.
    pub fn of(&self, caller: &ComputerCaller) -> Option<&ComputerSession> {
        self.by_owner.get(&owner_key(caller))
    }

    /// A session by id.
    pub fn by_id(&self, id: &str) -> Option<&ComputerSession> {
        self.by_owner.values().find(|session| session.id == id)
    }

    /// Every live session, oldest first.
    pub fn all(&self) -> Vec<ComputerSession> {
        let mut all: Vec<ComputerSession> = self.by_owner.values().cloned().collect();
        all.sort_by_key(|session| session.started_at);
        all
    }

    /// Takes the lease on `app_key` for `session_id`, or names the holder.
    pub fn lease(
        &mut self,
        session_id: &str,
        app_key: &str,
        app_name: &str,
        pid: Option<u64>,
        now: u64,
    ) -> Result<bool, ComputerFailure> {
        match self.leases.acquire(app_key, session_id) {
            LeaseOutcome::Granted { newly } => {
                if newly {
                    if let Some(session) = self.by_owner.values_mut().find(|s| s.id == session_id) {
                        session.leases.push(ComputerLease {
                            app_key: app_key.to_string(),
                            app_name: app_name.to_string(),
                            pid,
                            acquired_at: now,
                        });
                    }
                }
                Ok(newly)
            }
            LeaseOutcome::Busy { holder } => {
                let holder = self.by_id(&holder).cloned();
                let who = holder
                    .as_ref()
                    .map_or_else(|| "another session".to_string(), |s| caller_label(&s.owner));
                let mut busy = failure(
                    ComputerErrorCode::AppBusy,
                    format!("{app_name} is being controlled by {who}"),
                );
                busy.hint = Some("Wait for that session to end, or ask the user to stop it from the Pragma sidebar.".to_string());
                if let Some(holder) = holder {
                    busy.details.insert(
                        "holder".to_string(),
                        serde_json::to_value(&holder.owner).unwrap_or_default(),
                    );
                    busy.details.insert(
                        "since".to_string(),
                        serde_json::Value::from(holder.started_at),
                    );
                    busy.details
                        .insert("sessionId".to_string(), serde_json::Value::from(holder.id));
                }
                Err(busy)
            }
        }
    }

    /// Records a completed action on a session.
    pub fn touch(
        &mut self,
        session_id: &str,
        now: u64,
        description: Option<String>,
    ) -> Option<ComputerSession> {
        let session = self.by_owner.values_mut().find(|s| s.id == session_id)?;
        session.last_action_at = now;
        session.action_count += 1;
        if description.is_some() {
            session.last_description = description;
        }
        Some(session.clone())
    }

    /// Sets or clears the pause flag on one session, or on all of them.
    pub fn set_paused(
        &mut self,
        session_id: Option<&str>,
        reason: Option<ComputerPauseReason>,
    ) -> Vec<ComputerSession> {
        self.by_owner
            .values_mut()
            .filter(|s| session_id.is_none_or(|id| s.id == id))
            .filter(|s| s.paused != reason.is_some() || s.pause_reason != reason)
            .map(|s| {
                if s.pause_reason == Some(ComputerPauseReason::Stopped) && reason.is_none() {
                    // Stopped leases remain as preview metadata until the user restarts.
                    s.leases.clear();
                }
                s.paused = reason.is_some();
                s.pause_reason = reason;
                s.clone()
            })
            .collect()
    }

    /// Releases a stopped session's leases but keeps its user-owned restart latch.
    pub fn stop(&mut self, id: &str) {
        self.leases.release_session(id);
    }

    /// Ends a session and releases its leases.
    pub fn end(&mut self, session_id: &str) -> Option<ComputerSession> {
        let key = self
            .by_owner
            .iter()
            .find(|(_, s)| s.id == session_id)
            .map(|(key, _)| key.clone())?;
        self.leases.release_session(session_id);
        self.by_owner.remove(&key)
    }

    /// Ends every session.
    pub fn end_all(&mut self) -> Vec<ComputerSession> {
        self.leases.clear();
        self.by_owner.drain().map(|(_, s)| s).collect()
    }

    /// Sessions idle for at least `idle_ms`.
    pub fn idle(&self, now: u64, idle_ms: u64) -> Vec<String> {
        self.by_owner
            .values()
            .filter(|s| !s.paused && now.saturating_sub(s.last_action_at) >= idle_ms)
            .map(|s| s.id.clone())
            .collect()
    }

    /// Sessions owned by a tab.
    pub fn of_tab(&self, tab_id: &str) -> Vec<String> {
        self.by_owner
            .values()
            .filter(|s| s.owner.tab_id.as_deref() == Some(tab_id))
            .map(|s| s.id.clone())
            .collect()
    }
}

/// The input mutex: FIFO-ish, bounded wait.
#[derive(Default)]
pub struct InputMutex {
    held: Mutex<bool>,
    released: Condvar,
}

/// Held for the length of one action; releases on drop.
pub struct InputGuard<'a> {
    mutex: &'a InputMutex,
}

impl InputMutex {
    /// Takes the mutex, waiting up to the shipped bound.
    pub fn take(&self) -> Result<InputGuard<'_>, ComputerFailure> {
        let wait = Duration::from_millis(CONSTANTS.computer.input_mutex_wait_ms.get());
        let held = self.lock()?;
        let (mut held, timeout) = self
            .released
            .wait_timeout_while(held, wait, |held| *held)
            .map_err(|_| failure(ComputerErrorCode::Internal, "input lock poisoned"))?;
        if timeout.timed_out() && *held {
            return Err(failure(
                ComputerErrorCode::InputBusy,
                "another agent is using the keyboard and pointer right now",
            ));
        }
        *held = true;
        Ok(InputGuard { mutex: self })
    }

    fn lock(&self) -> Result<MutexGuard<'_, bool>, ComputerFailure> {
        self.held
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "input lock poisoned"))
    }
}

impl Drop for InputGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut held) = self.mutex.held.lock() {
            *held = false;
        }
        self.mutex.released.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pragma_constants::ComputerCallerKind;

    fn tab(id: &str) -> ComputerCaller {
        ComputerCaller {
            kind: ComputerCallerKind::AgentTab,
            tab_id: Some(id.to_string()),
            worktree_id: Some("wt".to_string()),
            agent_id: Some("claude-code".to_string()),
            plugin_id: None,
            label: Some(format!("Agent {id}")),
        }
    }

    #[test]
    fn one_session_per_owner_and_exclusive_leases() {
        let mut sessions = Sessions::default();
        let (a, new_a) = sessions.open(&tab("1"), 10);
        let (again, new_again) = sessions.open(&tab("1"), 11);
        assert!(new_a && !new_again);
        assert_eq!(a.id, again.id);
        let (b, _) = sessions.open(&tab("2"), 12);
        assert!(sessions
            .lease(&a.id, "com.apple.safari", "Safari", Some(1), 13)
            .unwrap());
        let busy = sessions
            .lease(&b.id, "com.apple.safari", "Safari", Some(1), 14)
            .unwrap_err();
        assert_eq!(busy.code, ComputerErrorCode::AppBusy);
        assert!(busy.message.contains("Agent 1"));
        assert_eq!(busy.details["sessionId"], a.id.as_str());
        sessions.end(&a.id);
        assert!(sessions
            .lease(&b.id, "com.apple.safari", "Safari", Some(1), 15)
            .unwrap());
        assert_eq!(sessions.of_tab("2"), vec![b.id.clone()]);
    }

    #[test]
    fn idle_sessions_are_found() {
        let mut sessions = Sessions::default();
        let (a, _) = sessions.open(&tab("1"), 0);
        assert_eq!(sessions.idle(119_999, 120_000), Vec::<String>::new());
        assert_eq!(sessions.idle(120_000, 120_000), vec![a.id]);
    }

    #[test]
    fn pause_flags_change_once() {
        let mut sessions = Sessions::default();
        sessions.open(&tab("1"), 0);
        assert_eq!(
            sessions
                .set_paused(None, Some(ComputerPauseReason::User))
                .len(),
            1
        );
        assert_eq!(
            sessions.set_paused(None, Some(ComputerPauseReason::User)),
            Vec::new()
        );
        assert_eq!(sessions.set_paused(None, None).len(), 1);
    }

    #[test]
    fn input_mutex_releases_on_drop() {
        let mutex = InputMutex::default();
        let guard = mutex.take().unwrap();
        drop(guard);
        assert!(mutex.take().is_ok());
    }
}
