/**
 * The project root whose theme the app should mirror, reported by whichever
 * project-scoped screen is currently focused.
 *
 * The desktop layers `.pragma/theme.json` as global <- selected project; this
 * app has no selected project, so the focused screen stands in for it: the
 * projects list reports `null` (global theme only) and the project, worktree,
 * and chat screens report their project's main-worktree path. `ThemeProvider`
 * subscribes here and passes the root to the gateway's theme route, which
 * layers that project's file over the global one.
 *
 * Kept RN-free so the store is Vitest-covered; the focus wiring lives in
 * `use-viewed-project.ts`.
 */

let viewedRoot: string | null = null;
const listeners = new Set<() => void>();

/** The current theme root: a project's main-worktree path, or `null` for the global theme alone. */
export function getViewedProjectRoot(): string | null {
  return viewedRoot;
}

/** Sets the theme root; a repeated value notifies no one. */
export function setViewedProjectRoot(root: string | null): void {
  if (root === viewedRoot) return;
  viewedRoot = root;
  for (const listener of listeners) listener();
}

/** Subscribes to root changes, `useSyncExternalStore`-style. */
export function subscribeViewedProject(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
