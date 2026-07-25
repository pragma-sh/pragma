import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pragma.worktreePins";
const listeners = new Set<() => void>();
let pins = readPins();

/** Returns whether a worktree is pinned. */
export function isWorktreePinned(worktreeId: string): boolean {
  return pins.has(worktreeId);
}

/** Returns the pin timestamp (ms) for a worktree, or undefined when unpinned. */
export function worktreePinTime(worktreeId: string): number | undefined {
  return pins.get(worktreeId);
}

/** Toggles a persisted worktree pin. Pinning records the current time so
 *  pinned rows can sort newest-pinned-first. */
export function toggleWorktreePin(worktreeId: string): void {
  pins = new Map(pins);
  if (pins.has(worktreeId)) {
    pins.delete(worktreeId);
  } else {
    pins.set(worktreeId, Date.now());
  }
  writePins(pins);
  for (const listener of listeners) {
    listener();
  }
}

/** React hook for the current worktree-id → pin-time map. */
export function useWorktreePins(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    subscribe,
    () => pins,
    () => new Map(),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readPins(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const next = new Map<string, number>();
    for (const [id, time] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof time === "number" && Number.isFinite(time)) {
        next.set(id, time);
      }
    }
    return next;
  } catch {
    return new Map();
  }
}

function writePins(value: Map<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(value)));
  } catch {
    // Pinning is cosmetic; ignore unavailable storage.
  }
}
