import { useSyncExternalStore } from "react";

/**
 * Git and GitHub actions running on a worktree — committing, pushing, opening
 * a pull request, and the AI steps that draft them — so the sidebar can report
 * them the way it reports agents.
 *
 * Callers wrap the work in {@link trackWorktreeActivity}; the entry shows while
 * it runs, then lingers briefly as done (or longer as failed) before it clears.
 * Ephemeral by design: these jobs run in this window, so nothing is persisted.
 */

/** What a worktree is busy with. */
export type WorktreeActivityKind =
  | "commit"
  | "commit-message"
  | "commit-and-draft"
  | "pr-draft"
  | "push"
  | "create-pr"
  | "merge";

/** Where a tracked action is in its life. */
export type WorktreeActivityState = "running" | "done" | "failed";

/** One tracked action. */
export interface WorktreeActivity {
  id: number;
  worktreeId: string;
  kind: WorktreeActivityKind;
  state: WorktreeActivityState;
  startedAt: number;
}

/** Sidebar wording per kind and state. */
const WORKTREE_ACTIVITY_LABELS: Record<
  WorktreeActivityKind,
  Record<WorktreeActivityState, string>
> = {
  commit: { running: "Committing", done: "Committed", failed: "Commit failed" },
  "commit-message": {
    running: "Writing commit message",
    done: "Commit message ready",
    failed: "Commit message failed",
  },
  "commit-and-draft": {
    running: "Committing & drafting PR",
    done: "Committed & drafted PR",
    failed: "Commit & draft failed",
  },
  "pr-draft": { running: "Drafting PR", done: "PR drafted", failed: "PR draft failed" },
  push: { running: "Pushing", done: "Pushed", failed: "Push failed" },
  "create-pr": { running: "Opening PR", done: "PR opened", failed: "Opening PR failed" },
  merge: { running: "Merging", done: "Merged", failed: "Merge failed" },
};

/** How long a finished action stays visible, by outcome. */
const LINGER_MS: Record<Exclude<WorktreeActivityState, "running">, number> = {
  done: 4000,
  failed: 10_000,
};

const EMPTY: readonly WorktreeActivity[] = [];
let activities: readonly WorktreeActivity[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: readonly WorktreeActivity[]): void {
  activities = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function settle(id: number, state: Exclude<WorktreeActivityState, "running">): void {
  publish(activities.map((activity) => (activity.id === id ? { ...activity, state } : activity)));
  setTimeout(() => publish(activities.filter((activity) => activity.id !== id)), LINGER_MS[state]);
}

/**
 * Runs `work`, reporting it on `worktreeId` as `kind` until it settles. The
 * work's result or error passes through untouched.
 */
export async function trackWorktreeActivity<T>(
  worktreeId: string,
  kind: WorktreeActivityKind,
  work: () => Promise<T>,
): Promise<T> {
  const id = nextId++;
  publish([...activities, { id, worktreeId, kind, state: "running", startedAt: Date.now() }]);
  try {
    const result = await work();
    settle(id, "done");
    return result;
  } catch (cause) {
    settle(id, "failed");
    throw cause;
  }
}

/** The newest tracked action on one worktree, or null when it is idle. */
export function useLatestWorktreeActivity(worktreeId: string): WorktreeActivity | null {
  return useSyncExternalStore(
    subscribe,
    () => activities.findLast((activity) => activity.worktreeId === worktreeId) ?? null,
    () => null,
  );
}

/** Sidebar label for an action. */
export function worktreeActivityLabel(activity: WorktreeActivity): string {
  return WORKTREE_ACTIVITY_LABELS[activity.kind][activity.state];
}
