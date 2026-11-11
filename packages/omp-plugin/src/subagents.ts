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
export class SubagentTracker {
  private readonly running = new Set<string>();
  private readonly listeners = new Set<(active: number) => void>();

  /** Number of subagents currently running a turn. */
  get active(): number {
    return this.running.size;
  }

  /** Marks a subagent as running; notifies listeners when the count changes. */
  start(id: string): void {
    if (this.running.has(id)) return;
    this.running.add(id);
    this.emit();
  }

  /** Marks a subagent as settled; notifies listeners when the count changes. */
  end(id: string): void {
    if (!this.running.delete(id)) return;
    this.emit();
  }

  /** Subscribes to count changes. Returns the unsubscribe function. */
  subscribe(listener: (active: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.running.size);
  }
}

/** The tracker shared by every binding of the extension in this process. */
export const sharedSubagentTracker = new SubagentTracker();
