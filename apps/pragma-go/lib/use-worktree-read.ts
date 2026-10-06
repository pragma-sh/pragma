import { useConnection } from "./connection-context";
import { useProjectRootPath, useWorktree } from "./data/data-context";
import { useHostValue, type HostValue } from "./use-host-value";
import { useViewedProjectRoot } from "./use-viewed-project";

type Client = NonNullable<ReturnType<typeof useConnection>["client"]>;

/**
 * One read scoped to a worktree's host path, for a screen that shows it.
 *
 * Waits for the workspace to know the worktree's path, keys the read by that
 * path plus `key`, and reports the worktree's project as the one in view so
 * its theme applies — the three things every worktree-scoped viewer needs.
 */
export function useWorktreeRead<T>(
  worktreeId: string,
  key: string,
  load: (client: Client, root: string) => Promise<T>,
): HostValue<T> {
  const worktree = useWorktree(worktreeId);
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  const root = worktree?.path;
  return useHostValue(root ? `${root}\0${key}` : null, (client) => load(client, root ?? ""));
}
