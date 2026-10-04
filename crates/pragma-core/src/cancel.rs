//! Cancellable, bounded long-running host operations.
//!
//! A palette search or a storage scan runs on one RPC call while a second call
//! — issued by the same client when the user types again or closes the page —
//! asks it to stop. Each operation kind owns one [`CancelRegistry`]; the
//! running call holds a [`CancelToken`] and polls it between units of work.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::{CoreError, CoreResult};

/// How many cancels for not-yet-registered ids a registry remembers.
const MAX_EARLY_CANCELS: usize = 64;

/// Operations in flight, plus cancels that arrived before their operation did.
struct State {
    active: Vec<(String, Arc<AtomicBool>)>,
    early_cancels: Vec<String>,
}

/// The in-flight operations of one kind, keyed by client-chosen id.
pub struct CancelRegistry {
    label: &'static str,
    limit: usize,
    state: Mutex<State>,
}

impl CancelRegistry {
    /// An empty registry that admits at most `limit` concurrent operations.
    #[must_use]
    pub const fn new(label: &'static str, limit: usize) -> Self {
        Self {
            label,
            limit,
            state: Mutex::new(State {
                active: Vec::new(),
                early_cancels: Vec::new(),
            }),
        }
    }

    /// Admits operation `id`, cancelling any earlier one that reused the id.
    ///
    /// # Errors
    ///
    /// Rejects an empty id and refuses a new operation once `limit` are running.
    pub fn register(&self, id: &str) -> CoreResult<CancelToken<'_>> {
        if id.is_empty() {
            return Err(CoreError::InvalidPayload(format!(
                "{} id is required",
                self.label
            )));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|error| CoreError::Operation(error.to_string()))?;
        let active = &mut state.active;
        if let Some(index) = active.iter().position(|(key, _)| key == id) {
            let (_, previous) = active.swap_remove(index);
            previous.store(true, Ordering::Relaxed);
        }
        if active.len() >= self.limit {
            return Err(CoreError::Operation(format!(
                "too many concurrent operations: {} limit is {}",
                self.label, self.limit
            )));
        }
        // A cancel that beat this registration (the client closed the page
        // while the request was still in flight) starts the operation stopped.
        let early = state.early_cancels.iter().position(|key| key == id);
        if let Some(index) = early {
            state.early_cancels.swap_remove(index);
        }
        let cancelled = Arc::new(AtomicBool::new(early.is_some()));
        state.active.push((id.to_string(), Arc::clone(&cancelled)));
        Ok(CancelToken {
            registry: self,
            cancelled,
        })
    }

    /// Asks operation `id` to stop. An id that is not running yet is
    /// remembered, so the operation stops as soon as it registers; ids are
    /// unique per call, so a remembered cancel for a finished one is inert.
    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.state.lock() {
            let mut found = false;
            for (key, cancelled) in &state.active {
                if key == id {
                    cancelled.store(true, Ordering::Relaxed);
                    found = true;
                }
            }
            if !found && !state.early_cancels.iter().any(|key| key == id) {
                if state.early_cancels.len() >= MAX_EARLY_CANCELS {
                    state.early_cancels.remove(0);
                }
                state.early_cancels.push(id.to_string());
            }
        }
    }
}

/// A running operation's handle. Dropping it releases the registry slot.
pub struct CancelToken<'a> {
    registry: &'a CancelRegistry,
    cancelled: Arc<AtomicBool>,
}

impl CancelToken<'_> {
    /// Whether the operation has been asked to stop.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Drop for CancelToken<'_> {
    fn drop(&mut self) {
        // Compared by identity, not id: a replacement that reused this id owns
        // its own slot, and a superseded token must not release it.
        if let Ok(mut state) = self.registry.state.lock() {
            state
                .active
                .retain(|(_, cancelled)| !Arc::ptr_eq(cancelled, &self.cancelled));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CancelRegistry;

    #[test]
    fn cancel_reaches_the_running_token() {
        let registry = CancelRegistry::new("test op", 4);
        let token = registry.register("a").unwrap();
        assert!(!token.is_cancelled());
        registry.cancel("a");
        assert!(token.is_cancelled());
    }

    #[test]
    fn a_cancel_before_registration_stops_the_operation_on_arrival() {
        let registry = CancelRegistry::new("test op", 4);
        registry.cancel("late");
        let token = registry.register("late").unwrap();
        assert!(token.is_cancelled());
        drop(token);
        assert!(!registry.register("late").unwrap().is_cancelled());
    }

    #[test]
    fn reusing_an_id_cancels_the_previous_operation() {
        let registry = CancelRegistry::new("test op", 4);
        let first = registry.register("a").unwrap();
        let second = registry.register("a").unwrap();
        assert!(first.is_cancelled());
        drop(first);
        // The superseded token's drop must leave the replacement registered.
        registry.cancel("a");
        assert!(second.is_cancelled());
    }

    #[test]
    fn the_limit_frees_up_when_a_token_drops() {
        let registry = CancelRegistry::new("test op", 1);
        let first = registry.register("a").unwrap();
        assert!(registry.register("b").is_err());
        drop(first);
        assert!(registry.register("b").is_ok());
        assert!(registry.register("").is_err());
    }
}
