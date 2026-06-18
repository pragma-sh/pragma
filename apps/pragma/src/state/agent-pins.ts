import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pragma.agentPins";
const listeners = new Set<() => void>();
let pins = readPins();

/** Returns whether an agent launcher is pinned. */
export function isAgentPinned(agentId: string): boolean {
  return pins.has(agentId);
}

/** Toggles a persisted agent launcher pin. */
export function toggleAgentPin(agentId: string): void {
  pins = new Set(pins);
  if (pins.has(agentId)) {
    pins.delete(agentId);
  } else {
    pins.add(agentId);
  }
  writePins(pins);
  for (const listener of listeners) {
    listener();
  }
}

/** React hook for the current pinned agent ids. */
export function useAgentPins(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => pins,
    () => new Set(),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readPins(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writePins(value: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    // Pinning is cosmetic; ignore unavailable storage.
  }
}
