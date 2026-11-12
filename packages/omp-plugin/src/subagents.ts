/**
 * Process-wide registry of running omp subagents.
 *
 * omp rebinds every extension factory to each subagent session it spawns
 * (task tool, eval `agent()`, `/tan` clones) without re-evaluating the module,
 * so one module-scoped tracker is shared by the main session's binding and
 * every in-process subagent binding. Subagents omp places on worker threads
 * (only once nine or more run at once) load their own module copy and are not
 * counted here.
 */
export interface SubagentTracker {
  /** Number of subagents currently running a turn. */
  readonly active: number;
  /** Marks a subagent as running; notifies listeners when the count changes. */
  start(id: string): void;
  /** Marks a subagent as settled; notifies listeners when the count changes. */
  end(id: string): void;
  /** Subscribes to count changes. Returns the unsubscribe function. */
  subscribe(listener: (active: number) => void): () => void;
}

/** Creates an empty subagent registry. */
export function createSubagentTracker(): SubagentTracker {
  const running = new Set<string>();
  const listeners = new Set<(active: number) => void>();
  const emit = () => {
    for (const listener of listeners) listener(running.size);
  };
  return {
    get active() {
      return running.size;
    },
    start(id) {
      if (running.has(id)) return;
      running.add(id);
      emit();
    },
    end(id) {
      if (!running.delete(id)) return;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The tracker shared by every binding of the extension in this process. */
export const sharedSubagentTracker = createSubagentTracker();
