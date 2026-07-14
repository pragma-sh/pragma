import { useSyncExternalStore } from "react";

export interface EditorLocationRequest {
  line: number;
  column: number;
  generation: number;
}

const requests = new Map<string, EditorLocationRequest>();
const listeners = new Set<() => void>();
let generation = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Requests that an editor tab reveal and focus a one-based source location. */
export function requestEditorLocation(tabId: string, line: number, column = 1): void {
  requests.set(tabId, {
    line: Math.max(1, Math.trunc(line)),
    column: Math.max(1, Math.trunc(column)),
    generation: ++generation,
  });
  emit();
}

/** Clears a location after its matching editor consumes it. */
export function clearEditorLocation(tabId: string, requestGeneration: number): void {
  if (requests.get(tabId)?.generation === requestGeneration) {
    requests.delete(tabId);
    emit();
  }
}

/** Subscribes an editor tab to its pending one-shot source location. */
export function useEditorLocation(tabId: string): EditorLocationRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requests.get(tabId) ?? null,
    () => null,
  );
}
