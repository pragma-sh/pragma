import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pragma.modelPins";
const listeners = new Set<() => void>();
let pins = readPins();

/** Returns whether a model is pinned within its agent's picker. */
export function isModelPinned(agentId: string, modelId: string): boolean {
  return pins.has(pinKey(agentId, modelId));
}

/** Toggles a persisted model pin for an agent. */
export function toggleModelPin(agentId: string, modelId: string): void {
  const key = pinKey(agentId, modelId);
  pins = new Set(pins);
  if (pins.has(key)) {
    pins.delete(key);
  } else {
    pins.add(key);
  }
  writePins(pins);
  for (const listener of listeners) {
    listener();
  }
}

/** Returns models with pinned ones first, preserving original order within each group. */
export function sortModelsByPin<T extends { id: string }>(
  agentId: string,
  models: T[],
  pinned: Set<string>,
): T[] {
  const top: T[] = [];
  const rest: T[] = [];
  for (const model of models) {
    (pinned.has(pinKey(agentId, model.id)) ? top : rest).push(model);
  }
  return [...top, ...rest];
}

/** React hook for the current set of pinned-model composite keys. */
export function useModelPins(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => pins,
    () => new Set(),
  );
}

// JSON-encoding the [agent, model] pair keeps the composite key collision-free
// regardless of which characters appear in either id.
function pinKey(agentId: string, modelId: string): string {
  return JSON.stringify([agentId, modelId]);
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
