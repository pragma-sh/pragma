import type { WorktreeChanges } from "@pragma-sh/sdk";

import {
  defineWorktreeSection,
  useWorktree,
  useWorktreeChanges,
  type PluginWorktree,
} from "@pragma-sh/plugin";

/** Staged and unstaged paths, each listed once. */
function uncommittedPaths(changes: WorktreeChanges | undefined): string[] {
  if (!changes) return [];
  return [...new Set([...changes.staged, ...changes.unstaged].map((file) => file.path))];
}

/** Badge: how many files the row's worktree has uncommitted; hidden when clean. */
function useUncommittedCount(worktree: PluginWorktree): number | null {
  const { data } = useWorktreeChanges(worktree.path);
  return data ? uncommittedPaths(data).length : null;
}

/** Body: the uncommitted paths, read for the row through `useWorktree()`. */
export function UncommittedSection() {
  const worktree = useWorktree();
  const { data } = useWorktreeChanges(worktree.path);
  return (
    <ul data-testid="uncommitted-files" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
      {uncommittedPaths(data).map((path) => (
        <li key={path} style={{ fontSize: 12 }}>
          {path}
        </li>
      ))}
    </ul>
  );
}

/** A worktree section listing each worktree's uncommitted files under its sidebar row. */
export const uncommittedSection = defineWorktreeSection({
  id: "uncommitted",
  title: "Uncommitted",
  component: UncommittedSection,
  useCount: useUncommittedCount,
});
