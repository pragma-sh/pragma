//! Keeps each session's overlay cursor on the window it last acted in.
//!
//! An action announces one point in screen coordinates, but the agent can sit
//! between actions for many seconds while the user moves that window or
//! brings another app forward. Without tracking, the cursor stays frozen at the
//! old point, floating over whatever is there now. Each action therefore
//! anchors its cursor to the target window ([`CursorAnchor`]), and the service
//! re-places every anchored cursor against the live window list a few times a
//! second, emitting `cursorMoved` only when something changed.

use std::collections::HashMap;
use std::sync::Mutex;

use pragma_constants::{ComputerPointer, ComputerWindow};
use pragma_core::computer::{track_cursor, CursorAnchor, TrackedCursor};

struct Entry {
    anchor: CursorAnchor,
    last: TrackedCursor,
}

/// The anchored cursors, by session id.
#[derive(Default)]
pub struct CursorTracker {
    entries: Mutex<HashMap<String, Entry>>,
}

impl CursorTracker {
    /// Anchors `session`'s cursor where an action just put it, or stops
    /// tracking it when the action landed outside any window of the target.
    pub fn anchor(&self, session: &str, placed: Option<(CursorAnchor, TrackedCursor)>) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        match placed {
            Some((anchor, last)) => {
                entries.insert(session.to_string(), Entry { anchor, last });
            }
            None => {
                entries.remove(session);
            }
        }
    }

    /// Drops cursors whose session has ended; true when none are left.
    pub fn retain(&self, live: impl Fn(&str) -> bool) -> bool {
        self.entries.lock().map_or(true, |mut entries| {
            entries.retain(|id, _| live(id));
            entries.is_empty()
        })
    }

    /// Re-places every cursor against `windows` (front to back) and returns
    /// the pointer for each one that moved, was covered or uncovered, or lost
    /// its window.
    pub fn update(&self, windows: &[ComputerWindow]) -> Vec<(String, ComputerPointer)> {
        let Ok(mut entries) = self.entries.lock() else {
            return Vec::new();
        };
        let mut changed = Vec::new();
        for (session, entry) in entries.iter_mut() {
            // A window that is gone hides the cursor where it last was.
            let next = track_cursor(windows, &entry.anchor).unwrap_or_else(|| TrackedCursor {
                covered: true,
                ..entry.last.clone()
            });
            if next == entry.last {
                continue;
            }
            changed.push((
                session.clone(),
                ComputerPointer {
                    from: None,
                    to: next.point.clone(),
                    display_id: None,
                    window: next.window.clone(),
                    covered: Some(next.covered),
                    lead_ms: 0,
                },
            ));
            entry.last = next;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use pragma_constants::{ComputerPoint, ComputerRect};

    use super::*;

    fn rect(x: f64, y: f64) -> ComputerRect {
        ComputerRect {
            x,
            y,
            w: 400.0,
            h: 300.0,
            display_id: None,
        }
    }

    fn window(id: &str, x: f64, y: f64) -> ComputerWindow {
        ComputerWindow {
            id: id.to_string(),
            app_id: "app:test".to_string(),
            app_name: "Test".to_string(),
            pid: 1,
            title: String::new(),
            frame: rect(x, y),
            focused: false,
            minimized: false,
            on_screen: true,
        }
    }

    fn tracker() -> CursorTracker {
        let tracker = CursorTracker::default();
        let point = ComputerPoint { x: 110.0, y: 110.0 };
        tracker.anchor(
            "s1",
            Some((
                CursorAnchor::new("w1", &rect(100.0, 100.0), &point),
                TrackedCursor {
                    point,
                    window: Some(rect(100.0, 100.0)),
                    covered: false,
                },
            )),
        );
        tracker
    }

    #[test]
    fn emits_only_when_the_window_changes() {
        let tracker = tracker();
        assert_eq!(tracker.update(&[window("w1", 100.0, 100.0)]), Vec::new());
        let moved = tracker.update(&[window("w1", 200.0, 100.0)]);
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].1.to, ComputerPoint { x: 210.0, y: 110.0 });
        assert_eq!(moved[0].1.covered, Some(false));
        assert_eq!(tracker.update(&[window("w1", 200.0, 100.0)]), Vec::new());
    }

    #[test]
    fn hides_the_cursor_when_covered_or_gone() {
        let tracker = tracker();
        let covered = tracker.update(&[window("other", 0.0, 0.0), window("w1", 100.0, 100.0)]);
        assert_eq!(covered[0].1.covered, Some(true));
        let tracker = self::tracker();
        let gone = tracker.update(&[window("other", 900.0, 900.0)]);
        assert_eq!(gone[0].1.covered, Some(true));
        assert_eq!(gone[0].1.to, ComputerPoint { x: 110.0, y: 110.0 });
    }

    #[test]
    fn forgets_ended_sessions() {
        let tracker = tracker();
        assert!(!tracker.retain(|id| id == "s1"));
        assert!(tracker.retain(|_| false));
        assert_eq!(tracker.update(&[window("w1", 0.0, 0.0)]), Vec::new());
    }
}
