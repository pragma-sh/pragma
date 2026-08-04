//! Tracks whether a desktop app is currently in front of the user.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use pragma_constants::CONSTANTS;

/// Shared record of the desktop's last reported window focus.
///
/// A phone push for an alert the user is already looking at on the desktop is
/// noise, so the worker holds it back while a *recent* heartbeat says the
/// desktop is focused. Heartbeats expire (`gateway.push.presenceTtlMs`) so a
/// desktop that dies mid-focus cannot suppress notifications forever.
#[derive(Clone, Default)]
pub struct DesktopPresence {
    state: Arc<Mutex<Option<Heartbeat>>>,
}

#[derive(Clone, Copy)]
struct Heartbeat {
    focused: bool,
    at_ms: u64,
}

impl DesktopPresence {
    /// Records a focus heartbeat from a desktop client.
    pub fn record(&self, focused: bool) {
        if let Ok(mut state) = self.state.lock() {
            *state = Some(Heartbeat {
                focused,
                at_ms: now_ms(),
            });
        }
    }

    /// Whether a desktop is focused right now, as far as this gateway knows.
    #[must_use]
    pub fn desktop_focused(&self) -> bool {
        self.focused_at(now_ms())
    }

    fn focused_at(&self, now_ms: u64) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        state.is_some_and(|heartbeat| {
            heartbeat.focused
                && now_ms.saturating_sub(heartbeat.at_ms)
                    <= CONSTANTS.gateway.push.presence_ttl_ms.get()
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{DesktopPresence, Heartbeat};
    use pragma_constants::CONSTANTS;

    fn presence(focused: bool, at_ms: u64) -> DesktopPresence {
        let presence = DesktopPresence::default();
        *presence.state.lock().expect("lock") = Some(Heartbeat { focused, at_ms });
        presence
    }

    #[test]
    fn an_unknown_desktop_never_suppresses() {
        assert!(!DesktopPresence::default().focused_at(1_000));
    }

    #[test]
    fn a_recent_focused_heartbeat_suppresses() {
        assert!(presence(true, 1_000).focused_at(1_500));
        assert!(!presence(false, 1_000).focused_at(1_500));
    }

    #[test]
    fn a_stale_heartbeat_stops_suppressing() {
        let ttl = CONSTANTS.gateway.push.presence_ttl_ms.get();
        assert!(presence(true, 1_000).focused_at(1_000 + ttl));
        assert!(!presence(true, 1_000).focused_at(1_000 + ttl + 1));
    }
}
