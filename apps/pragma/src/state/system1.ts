import { useEffect, useSyncExternalStore } from "react";

import { system1Status, type System1Status } from "@/lib/tauri";

/**
 * Whether a System 1 model is configured, shared by every agent picker, the
 * Settings page, and onboarding.
 *
 * `null` means "not loaded yet". The status is loaded once on first use and
 * replaced by whatever {@link setSystem1Status} is handed after a Settings
 * change, so every mounted picker shows or hides Auto together.
 */
let status: System1Status | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publishes a fresh status (e.g. the result of saving or clearing the key). */
export function setSystem1Status(next: System1Status): void {
  status = next;
  notify();
}

/** Re-reads the status from the backend. Failures leave the last known status. */
function refreshSystem1Status(): Promise<void> {
  // Deferred so a synchronous throw (no Tauri bridge) lands in the same
  // fallback as a rejected call.
  loading ??= Promise.resolve()
    .then(() => system1Status())
    .then(setSystem1Status, () => {
      // No backend (tests, a browser build) reads as "not configured".
      if (status === null) setSystem1Status({ configured: false, baseUrl: "", model: "" });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The current System 1 status, loading it on first use. */
export function useSystem1Status(): System1Status | null {
  const current = useSyncExternalStore(
    subscribe,
    () => status,
    () => null,
  );
  useEffect(() => {
    if (status === null) void refreshSystem1Status();
  }, []);
  return current;
}
