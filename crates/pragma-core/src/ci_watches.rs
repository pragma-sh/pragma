//! Host-owned CI watch records, one per worktree.
//!
//! The host owns the *record* so every caller sees the same thing: the desktop
//! arms a watch from the PR pane, an agent running in the worktree reads or
//! disarms it with `pragma-cli ci`, and the sidebar shows why it stopped. The
//! desktop *drives* it — GitHub polling, fix-agent tabs, and the merge stay in
//! the client that holds the GitHub session and the agent catalog — and reports
//! each transition back through `update`.
//!
//! Records are in memory: a watch lives as long as the host server, like the
//! PTYs whose agents it launches.
//!
//! A terminal record (`merged`, `failed`, `disarmed`) is never rewritten by
//! `update`: a disarm from the CLI racing the desktop's next progress write must
//! win, so the late write is rejected as stale and the desktop re-reads.
//!
//! Every arm issues a new `id`, and `update` names the one it started from, so a
//! poll that outlives a re-arm cannot touch the replacement.
//!
//! `merging` is the point of no return: the desktop writes it immediately before
//! sending the merge, so from then on `arm`, `disarm`, and `clear` are refused
//! rather than reporting a cancellation that would not stop the merge.

use std::collections::BTreeMap;
use std::sync::Mutex;

use chrono::Utc;
use pragma_constants::{CiWatch, CiWatchMode, CiWatchStatus};
use serde::Deserialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{CoreError, CoreResult};

/// Reason recorded when a disarm names none.
const DEFAULT_DISARM_REASON: &str = "Disarmed with `pragma-cli ci disarm`.";

/// Why a watch cannot be changed while its merge is in flight.
const MERGE_IN_FLIGHT: &str =
    "the merge has already been sent to GitHub, so this CI watch can no longer be cancelled";

/// One `ciWatches` RPC request.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CiWatchesRequest {
    /// Every record, or only those for the given worktrees.
    List {
        #[serde(default)]
        worktree_ids: Option<Vec<String>>,
    },
    /// One worktree's record, or null.
    Get { worktree_id: String },
    /// Starts (or restarts) a worktree's watch, replacing any previous record.
    Arm {
        worktree_id: String,
        mode: CiWatchMode,
        agent_id: String,
        #[serde(default)]
        model_id: Option<String>,
        #[serde(default)]
        reasoning_id: Option<String>,
        #[serde(default)]
        pr_number: Option<u64>,
    },
    /// Progress from the driving client; rejected once the record is terminal.
    Update {
        worktree_id: String,
        watch_id: String,
        #[serde(flatten)]
        changes: Map<String, Value>,
    },
    /// Stops a live watch and records why, so the user sees the full reason.
    Disarm {
        worktree_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Forgets a worktree's record entirely, or only the arm named by `watch_id`.
    Clear {
        worktree_id: String,
        #[serde(default)]
        watch_id: Option<String>,
    },
}

/// Fields `update` may change; everything else on a record is fixed at arm time.
const UPDATABLE_FIELDS: &[&str] = &[
    "status",
    "attempts",
    "error",
    "prNumber",
    "fixTabId",
    "fixHeadSha",
    "fixChecks",
];

/// In-memory CI watch records keyed by worktree id.
#[derive(Default)]
pub struct CiWatchStore {
    records: Mutex<BTreeMap<String, CiWatch>>,
}

impl CiWatchStore {
    /// Creates an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Handles one `ciWatches` RPC payload.
    pub fn handle(&self, payload: Value) -> CoreResult<Value> {
        let request: CiWatchesRequest = serde_json::from_value(payload)
            .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
        let mut records = self
            .records
            .lock()
            .map_err(|_| CoreError::Operation("ci watch store lock poisoned".to_string()))?;
        let value = match request {
            CiWatchesRequest::List { worktree_ids } => to_value(
                records
                    .values()
                    .filter(|record| {
                        worktree_ids
                            .as_ref()
                            .is_none_or(|ids| ids.contains(&record.worktree_id))
                    })
                    .collect::<Vec<_>>(),
            ),
            CiWatchesRequest::Get { worktree_id } => to_value(records.get(&worktree_id)),
            CiWatchesRequest::Arm {
                worktree_id,
                mode,
                agent_id,
                model_id,
                reasoning_id,
                pr_number,
            } => {
                ensure_cancellable(records.get(&worktree_id))?;
                let now = now_millis();
                let record = from_value(serde_json::json!({
                    "id": Uuid::new_v4().to_string(),
                    "worktreeId": worktree_id,
                    "mode": mode,
                    "agentId": agent_id,
                    "modelId": model_id,
                    "reasoningId": reasoning_id,
                    "prNumber": pr_number,
                    "status": CiWatchStatus::Watching,
                    "attempts": 0,
                    "error": null,
                    "fixTabId": null,
                    "fixHeadSha": null,
                    "fixChecks": null,
                    "createdAt": now,
                    "updatedAt": now,
                }))?;
                let value = to_value(&record);
                records.insert(worktree_id, record);
                value
            }
            CiWatchesRequest::Update {
                worktree_id,
                watch_id,
                changes,
            } => {
                let record = live_record(&mut records, &worktree_id)?;
                if record.id != watch_id {
                    return Err(CoreError::StaleWrite);
                }
                *record = apply_update(record, changes)?;
                to_value(&*record)
            }
            CiWatchesRequest::Disarm {
                worktree_id,
                reason,
            } => {
                let record = live_record(&mut records, &worktree_id)?;
                ensure_cancellable(Some(record))?;
                let reason = reason
                    .map(|reason| reason.trim().to_string())
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| DEFAULT_DISARM_REASON.to_string());
                record.status = CiWatchStatus::Disarmed;
                record.error = Some(reason);
                record.updated_at = now_millis();
                to_value(&*record)
            }
            CiWatchesRequest::Clear {
                worktree_id,
                watch_id,
            } => {
                let record = records.get(&worktree_id);
                let cleared = match (record, watch_id) {
                    // The driving client forgetting its own watch, merging or not.
                    (Some(record), Some(watch_id)) => record.id == watch_id,
                    (record, None) => {
                        ensure_cancellable(record)?;
                        record.is_some()
                    }
                    (None, Some(_)) => false,
                };
                if cleared {
                    records.remove(&worktree_id);
                }
                to_value(serde_json::json!({ "cleared": cleared }))
            }
        };
        value
    }
}

/// Whether a status still accepts progress.
#[must_use]
pub fn is_live(status: CiWatchStatus) -> bool {
    matches!(
        status,
        CiWatchStatus::Watching | CiWatchStatus::Fixing | CiWatchStatus::Merging
    )
}

/// Refuses to cancel or replace a watch whose merge is already in flight.
fn ensure_cancellable(record: Option<&CiWatch>) -> CoreResult<()> {
    if record.is_some_and(|record| record.status == CiWatchStatus::Merging) {
        return Err(CoreError::Operation(MERGE_IN_FLIGHT.to_string()));
    }
    Ok(())
}

/// A worktree's record, provided it is still live.
fn live_record<'a>(
    records: &'a mut BTreeMap<String, CiWatch>,
    worktree_id: &str,
) -> CoreResult<&'a mut CiWatch> {
    let record = records
        .get_mut(worktree_id)
        .ok_or_else(|| CoreError::NotFound(format!("no CI watch for worktree {worktree_id}")))?;
    if is_live(record.status) {
        Ok(record)
    } else {
        Err(CoreError::StaleWrite)
    }
}

/// Merges the allowed `changes` into a copy of `record`, validated by the shared schema type.
fn apply_update(record: &CiWatch, changes: Map<String, Value>) -> CoreResult<CiWatch> {
    let mut value =
        serde_json::to_value(record).map_err(|error| CoreError::Operation(error.to_string()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| CoreError::Operation("ci watch is not an object".to_string()))?;
    for (key, change) in changes {
        if !UPDATABLE_FIELDS.contains(&key.as_str()) {
            return Err(CoreError::InvalidPayload(format!(
                "`{key}` cannot be updated on a CI watch"
            )));
        }
        object.insert(key, change);
    }
    object.insert("updatedAt".to_string(), Value::from(now_millis()));
    from_value(value)
}

fn from_value(value: Value) -> CoreResult<CiWatch> {
    serde_json::from_value(value).map_err(|error| CoreError::InvalidPayload(error.to_string()))
}

fn to_value<T: serde::Serialize>(value: T) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Operation(error.to_string()))
}

fn now_millis() -> u64 {
    u64::try_from(Utc::now().timestamp_millis()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn arm(store: &CiWatchStore, worktree_id: &str) -> Value {
        store
            .handle(json!({
                "action": "arm",
                "worktreeId": worktree_id,
                "mode": "watchMerge",
                "agentId": "claude-code",
            }))
            .unwrap()
    }

    #[test]
    fn arms_lists_and_clears() {
        let store = CiWatchStore::new();
        let record = arm(&store, "w1");
        assert_eq!(record["status"], "watching");
        assert_eq!(record["attempts"], 0);
        arm(&store, "w2");

        let all = store.handle(json!({ "action": "list" })).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 2);
        let one = store
            .handle(json!({ "action": "list", "worktreeIds": ["w2"] }))
            .unwrap();
        assert_eq!(one[0]["worktreeId"], "w2");

        let cleared = store
            .handle(json!({ "action": "clear", "worktreeId": "w1" }))
            .unwrap();
        assert_eq!(cleared["cleared"], true);
        let gone = store
            .handle(json!({ "action": "get", "worktreeId": "w1" }))
            .unwrap();
        assert!(gone.is_null());
    }

    #[test]
    fn updates_progress_but_not_fixed_fields() {
        let store = CiWatchStore::new();
        let id = arm(&store, "w1")["id"].clone();
        let updated = store
            .handle(json!({
                "action": "update",
                "worktreeId": "w1",
                "watchId": id,
                "status": "fixing",
                "attempts": 1,
                "fixTabId": "tab-1",
                "prNumber": 7,
            }))
            .unwrap();
        assert_eq!(updated["status"], "fixing");
        assert_eq!(updated["attempts"], 1);
        assert_eq!(updated["fixTabId"], "tab-1");
        assert_eq!(updated["prNumber"], 7);

        let error = store
            .handle(
                json!({ "action": "update", "worktreeId": "w1", "watchId": id, "mode": "watch" }),
            )
            .unwrap_err();
        assert!(matches!(error, CoreError::InvalidPayload(_)));
    }

    #[test]
    fn disarm_wins_over_a_late_update() {
        let store = CiWatchStore::new();
        let id = arm(&store, "w1")["id"].clone();
        let disarmed = store
            .handle(json!({
                "action": "disarm",
                "worktreeId": "w1",
                "reason": "  needs a secret the agent cannot read  ",
            }))
            .unwrap();
        assert_eq!(disarmed["status"], "disarmed");
        assert_eq!(disarmed["error"], "needs a secret the agent cannot read");

        let late = store
            .handle(
                json!({ "action": "update", "worktreeId": "w1", "watchId": id, "status": "fixing" }),
            )
            .unwrap_err();
        assert!(matches!(late, CoreError::StaleWrite));
    }

    #[test]
    fn disarm_without_reason_records_a_default() {
        let store = CiWatchStore::new();
        arm(&store, "w1");
        let disarmed = store
            .handle(json!({ "action": "disarm", "worktreeId": "w1" }))
            .unwrap();
        assert_eq!(disarmed["error"], DEFAULT_DISARM_REASON);
        let missing = store
            .handle(json!({ "action": "disarm", "worktreeId": "nope" }))
            .unwrap_err();
        assert!(matches!(missing, CoreError::NotFound(_)));
    }

    fn update(store: &CiWatchStore, id: &Value, status: &str) -> CoreResult<Value> {
        store.handle(
            json!({ "action": "update", "worktreeId": "w1", "watchId": id, "status": status }),
        )
    }

    #[test]
    fn rearming_rejects_progress_from_the_earlier_watch() {
        let store = CiWatchStore::new();
        let old = arm(&store, "w1")["id"].clone();
        let new = arm(&store, "w1")["id"].clone();
        assert_ne!(old, new);

        let error = update(&store, &old, "fixing").unwrap_err();
        assert!(matches!(error, CoreError::StaleWrite));
        let cleared = store
            .handle(json!({ "action": "clear", "worktreeId": "w1", "watchId": old }))
            .unwrap();
        assert_eq!(cleared["cleared"], false);
        assert_eq!(update(&store, &new, "fixing").unwrap()["status"], "fixing");
    }

    #[test]
    fn a_merge_in_flight_cannot_be_cancelled() {
        let store = CiWatchStore::new();
        let id = arm(&store, "w1")["id"].clone();
        update(&store, &id, "merging").unwrap();

        for action in ["disarm", "clear"] {
            let error = store
                .handle(json!({ "action": action, "worktreeId": "w1" }))
                .unwrap_err();
            assert!(error.to_string().contains(MERGE_IN_FLIGHT));
        }
        let rearm = store.handle(json!({
            "action": "arm",
            "worktreeId": "w1",
            "mode": "watch",
            "agentId": "claude-code",
        }));
        assert!(rearm.is_err());
        assert_eq!(update(&store, &id, "merged").unwrap()["status"], "merged");
    }
}
