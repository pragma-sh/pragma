//! The `computerActivity` event bus: every operation, whoever called it,
//! emits the same events here, and every subscriber (the desktop's sidebar,
//! picture-in-picture, and overlay cursor; `pragma-cli computer status --events`) reads them.
//!
//! Snapshot-then-delta like every other stream: a new subscriber first gets
//! the whole live picture (`ComputerActivitySnapshot`), then one
//! `ComputerActivityEvent` per delta. Events never carry typed text or pixels.

use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

use pragma_constants::{ComputerActivityEvent, ComputerActivityType, ProtocolEventKind};
use pragma_protocol::EventFrame;

/// Recent events kept for `status` callers that want a short history.
const HISTORY: usize = 200;

struct Inner {
    seq: u64,
    history: VecDeque<ComputerActivityEvent>,
    subscribers: Vec<Sender<EventFrame>>,
}

/// The bus.
pub struct ActivityBus {
    inner: Mutex<Inner>,
}

impl Default for ActivityBus {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                seq: 0,
                history: VecDeque::new(),
                subscribers: Vec::new(),
            }),
        }
    }
}

/// A blank event of `kind`, for the emitter to fill in.
#[must_use]
pub fn event(kind: ComputerActivityType) -> ComputerActivityEvent {
    ComputerActivityEvent {
        seq: 0,
        at: 0,
        type_: kind,
        session_id: None,
        action_id: None,
        caller: None,
        op: None,
        target: None,
        pointer: None,
        method: None,
        physical_cursor: None,
        description: None,
        error: None,
        session: None,
        approval: None,
        helper: None,
        task: None,
    }
}

impl ActivityBus {
    /// The last sequence number handed out.
    pub fn last_seq(&self) -> u64 {
        self.inner.lock().map_or(0, |inner| inner.seq)
    }

    /// Numbers, records, and fans out one event.
    pub fn emit(&self, mut event: ComputerActivityEvent) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.seq += 1;
        event.seq = inner.seq;
        event.at = super::now_ms();
        // Cursor tracking fires many times a second while a window is dragged;
        // keeping it would push every real action out of the history.
        if event.type_ != ComputerActivityType::CursorMoved {
            if inner.history.len() >= HISTORY {
                inner.history.pop_front();
            }
            inner.history.push_back(event.clone());
        }
        let Ok(payload) = serde_json::to_value(&event) else {
            return;
        };
        let frame = EventFrame::Delta {
            subscription: ProtocolEventKind::ComputerActivity,
            payload,
        };
        inner
            .subscribers
            .retain(|tx| tx.send(frame.clone()).is_ok());
    }

    /// Subscribes, replaying a snapshot first. The listener is registered
    /// *before* `snapshot` runs (under no bus lock, since building it emits
    /// nothing but reads state other emitters lock), so an event emitted while
    /// it is built is never lost: it reaches the listener as a delta, which the
    /// client applies on top. Deltas are idempotent, so one the snapshot
    /// already reflects is harmless.
    pub fn subscribe(
        &self,
        snapshot: impl FnOnce() -> serde_json::Value,
    ) -> (Vec<EventFrame>, Receiver<EventFrame>) {
        let (tx, rx) = mpsc::channel();
        if let Ok(mut inner) = self.inner.lock() {
            inner.subscribers.push(tx);
        }
        (
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::ComputerActivity,
                payload: snapshot(),
            }],
            rx,
        )
    }

    /// Recent events, oldest first.
    #[cfg(test)]
    pub fn history(&self) -> Vec<ComputerActivityEvent> {
        self.inner
            .lock()
            .map(|inner| inner.history.iter().cloned().collect())
            .unwrap_or_default()
    }
}
