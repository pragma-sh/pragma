/**
 * Tiny host-side event bus backing plugins' `useEvent` hook and declarative
 * `events` handlers. The host emits named events (e.g. `"agent.report"`); each
 * subscriber failure is isolated so one broken plugin can't break another.
 */

type PluginEventHandler = (payload: unknown) => void;

const handlers = new Map<string, Set<PluginEventHandler>>();

/** Subscribes to a named plugin event. Returns an unsubscribe function. */
export function subscribePluginEvent(eventName: string, handler: PluginEventHandler): () => void {
  let set = handlers.get(eventName);
  if (!set) {
    set = new Set();
    handlers.set(eventName, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(eventName);
    }
  };
}

/** Emits a named plugin event to every subscriber, isolating handler errors. */
export function emitPluginEvent(eventName: string, payload: unknown): void {
  const set = handlers.get(eventName);
  if (!set) {
    return;
  }
  for (const handler of set) {
    try {
      handler(payload);
    } catch (cause) {
      console.error(`plugin event handler for "${eventName}" threw`, cause);
    }
  }
}
