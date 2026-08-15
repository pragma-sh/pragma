use std::io::BufRead;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{
    AgentAnswer, AgentAttentionKind, AgentDecision, AgentInput, AgentInterrupt, AgentMessage,
    AgentQuestion, AgentStatus, ProtocolEventKind, QuestionOption,
};
use serde::Deserialize;
use serde_json::Value;

/// Strict mirror of gateway agent/subscription NDJSON events.
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum VerifyEvent {
    Ready,
    Agent {
        worktree_id: String,
        tab_id: String,
        agent: String,
        status: Option<AgentStatus>,
        session_name: Option<String>,
        attention_kind: Option<AgentAttentionKind>,
        command: Option<String>,
        question: Option<String>,
        options: Option<Vec<QuestionOption>>,
        questions: Option<Vec<AgentQuestion>>,
        request_id: Option<String>,
    },
    AgentMessage {
        message: AgentMessage,
    },
    AgentDecision {
        decision: AgentDecision,
    },
    AgentAnswer {
        answer: AgentAnswer,
    },
    AgentInput {
        input: AgentInput,
    },
    AgentInterrupt {
        interrupt: AgentInterrupt,
    },
    Snapshot {
        #[serde(rename = "subscription")]
        _subscription: ProtocolEventKind,
        payload: Value,
    },
    Delta {
        #[serde(rename = "subscription")]
        _subscription: ProtocolEventKind,
        #[serde(rename = "payload")]
        _payload: Value,
    },
}

impl VerifyEvent {
    /// `(worktreeId, tabId, agent)` scope triple, or `None` for stream-control
    /// lines (`ready`, subscription snapshots/deltas) that carry no session.
    pub fn scope(&self) -> Option<(&str, &str, &str)> {
        match self {
            VerifyEvent::Agent {
                worktree_id,
                tab_id,
                agent,
                ..
            } => Some((worktree_id, tab_id, agent)),
            VerifyEvent::AgentMessage { message } => {
                Some((&message.worktree_id, &message.tab_id, &message.agent))
            }
            VerifyEvent::AgentDecision { decision } => {
                Some((&decision.worktree_id, &decision.tab_id, &decision.agent))
            }
            VerifyEvent::AgentAnswer { answer } => {
                Some((&answer.worktree_id, &answer.tab_id, &answer.agent))
            }
            VerifyEvent::AgentInput { input } => {
                Some((&input.worktree_id, &input.tab_id, &input.agent))
            }
            VerifyEvent::AgentInterrupt { interrupt } => {
                Some((&interrupt.worktree_id, &interrupt.tab_id, &interrupt.agent))
            }
            VerifyEvent::Ready | VerifyEvent::Snapshot { .. } | VerifyEvent::Delta { .. } => None,
        }
    }
}

#[derive(Default)]
struct LedgerState {
    events: Vec<(VerifyEvent, Value)>,
    schema_errors: Vec<String>,
    ready_count: usize,
}

/// Thread-safe event ledger with cursor-based waits.
#[derive(Clone, Default)]
pub struct Ledger {
    inner: Arc<(Mutex<LedgerState>, Condvar)>,
}

/// One matched event and cursor immediately after it.
pub struct EventMatch {
    pub cursor: usize,
    pub event: VerifyEvent,
}

impl Ledger {
    /// Starts a collector thread over a gateway NDJSON reader.
    pub fn collect(reader: Box<dyn BufRead + Send>) -> Self {
        let ledger = Self::default();
        let collector = ledger.clone();
        thread::spawn(move || collector.ingest_reader(reader));
        ledger
    }

    /// Current event cursor.
    pub fn cursor(&self) -> usize {
        self.inner.0.lock().map_or(0, |state| state.events.len())
    }

    /// Waits for first matching event at or after `cursor`.
    pub fn wait_for(
        &self,
        cursor: usize,
        timeout: Duration,
        mut predicate: impl FnMut(&VerifyEvent) -> bool,
    ) -> Result<EventMatch, String> {
        let deadline = Instant::now() + timeout;
        let (lock, changed) = &*self.inner;
        let mut state = lock.lock().map_err(|_| "event ledger lock poisoned")?;
        loop {
            if let Some((offset, (event, _))) = state.events[cursor..]
                .iter()
                .enumerate()
                .find(|(_, (event, _))| predicate(event))
            {
                return Ok(EventMatch {
                    cursor: cursor + offset + 1,
                    event: event.clone(),
                });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("timed out waiting for agent event".to_string());
            }
            let (next, result) = changed
                .wait_timeout(state, deadline - now)
                .map_err(|_| "event ledger lock poisoned")?;
            state = next;
            if result.timed_out() {
                return Err("timed out waiting for agent event".to_string());
            }
        }
    }

    /// Returns cloned events from a cursor onward.
    pub fn events_since(&self, cursor: usize) -> Vec<VerifyEvent> {
        self.inner.0.lock().map_or_else(
            |_| Vec::new(),
            |state| {
                state.events[cursor..]
                    .iter()
                    .map(|(event, _)| event.clone())
                    .collect()
            },
        )
    }

    /// Returns capped raw event evidence from a cursor onward.
    pub fn evidence_since(&self, cursor: usize, limit: usize) -> Vec<Value> {
        self.evidence_filtered(cursor, limit, |_| true)
    }

    /// Returns capped raw event evidence from a cursor onward, restricted to
    /// events attributed to one of `tab_ids`. Keeps concurrent scenarios from
    /// leaking each other's sessions into failure evidence.
    pub fn evidence_since_for_tabs(
        &self,
        cursor: usize,
        limit: usize,
        tab_ids: &[String],
    ) -> Vec<Value> {
        self.evidence_filtered(cursor, limit, |event| {
            event
                .scope()
                .is_some_and(|(_, tab, _)| tab_ids.iter().any(|id| id == tab))
        })
    }

    fn evidence_filtered(
        &self,
        cursor: usize,
        limit: usize,
        keep: impl Fn(&VerifyEvent) -> bool,
    ) -> Vec<Value> {
        self.inner.0.lock().map_or_else(
            |_| Vec::new(),
            |state| {
                state.events[cursor..]
                    .iter()
                    .filter(|(event, _)| keep(event))
                    .rev()
                    .take(limit)
                    .map(|(_, value)| value.clone())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            },
        )
    }

    /// Strict-schema failures observed by collector.
    pub fn schema_errors(&self) -> Vec<String> {
        self.inner.0.lock().map_or_else(
            |_| vec!["event ledger lock poisoned".to_string()],
            |state| state.schema_errors.clone(),
        )
    }

    /// Number of initial/keepalive ready lines observed.
    pub fn ready_count(&self) -> usize {
        self.inner.0.lock().map_or(0, |state| state.ready_count)
    }

    fn ingest_reader(&self, reader: Box<dyn BufRead + Send>) {
        for line in reader.lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => self.ingest_line(&line),
                Ok(_) => {}
                Err(error) => {
                    self.record_schema_error(format!("read event stream: {error}"));
                    break;
                }
            }
        }
    }

    pub(crate) fn ingest_line(&self, line: &str) {
        let raw = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(error) => {
                self.record_schema_error(format!("invalid JSON: {error}: {line}"));
                return;
            }
        };
        if raw.get("type").and_then(Value::as_str) == Some("ready")
            && raw.as_object().is_some_and(|object| object.len() != 1)
        {
            self.record_schema_error(format!("schema error: ready has unknown fields: {line}"));
            return;
        }
        match serde_json::from_value::<VerifyEvent>(raw.clone()) {
            Ok(VerifyEvent::Ready) => {
                if let Ok(mut state) = self.inner.0.lock() {
                    state.ready_count += 1;
                    self.inner.1.notify_all();
                }
            }
            Ok(event) => {
                if let Ok(mut state) = self.inner.0.lock() {
                    state.events.push((event, raw));
                    self.inner.1.notify_all();
                }
            }
            Err(error) => self.record_schema_error(format!("schema error: {error}: {line}")),
        }
    }

    fn record_schema_error(&self, error: String) {
        if let Ok(mut state) = self.inner.0.lock() {
            state.schema_errors.push(error);
            self.inner.1.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn collects_ready_and_waits_from_cursor() {
        let input = concat!(
            "{\"type\":\"ready\"}\n",
            "{\"type\":\"agent\",\"worktreeId\":\"w\",\"tabId\":\"t\",\"agent\":\"a\",\"status\":\"running\",\"attentionKind\":null,\"command\":null,\"question\":null,\"options\":null,\"requestId\":null}\n"
        );
        let ledger = Ledger::collect(Box::new(Cursor::new(input.as_bytes().to_vec())));
        let found = ledger
            .wait_for(0, Duration::from_secs(1), |event| {
                matches!(event, VerifyEvent::Agent { .. })
            })
            .expect("agent event");
        assert_eq!(found.cursor, 1);
        assert_eq!(ledger.ready_count(), 1);
    }

    #[test]
    fn rejects_unknown_event_fields() {
        let ledger = Ledger::collect(Box::new(Cursor::new(
            b"{\"type\":\"agent\",\"worktreeId\":\"w\",\"tabId\":\"t\",\"agent\":\"a\",\"status\":\"running\",\"attentionKind\":null,\"command\":null,\"question\":null,\"options\":null,\"requestId\":null,\"extra\":true}\n".to_vec(),
        )));
        for _ in 0..20 {
            if !ledger.schema_errors().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(ledger.schema_errors().len(), 1);
    }

    #[test]
    fn waits_for_delayed_feeder_event() {
        let ledger = Ledger::default();
        let feeder = ledger.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            feeder.ingest_line(
                r#"{"type":"agent","worktreeId":"w","tabId":"t","agent":"a","status":"done","attentionKind":null,"command":null,"question":null,"options":null,"requestId":null}"#,
            );
        });
        let found = ledger
            .wait_for(0, Duration::from_secs(1), |event| {
                matches!(
                    event,
                    VerifyEvent::Agent {
                        status: Some(AgentStatus::Done),
                        ..
                    }
                )
            })
            .expect("delayed event");
        assert_eq!(found.cursor, 1);
    }
}
