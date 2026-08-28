import type { Worktree } from "@pragma/constants";

import { githubFetchAndSync } from "@/lib/tauri";

/** Main worktree and remote commit count when project main needs syncing. */
export interface MainBehindRemote {
  id: string;
  behind: number;
}

/**
 * Returns project main when it is behind its remote. Network/auth failures are
 * treated as unknown so offline worktree creation remains available.
 */
export async function mainBehindRemote(
  worktrees: readonly Worktree[],
): Promise<MainBehindRemote | null> {
  const main = worktrees.find((worktree) => worktree.isMain);
  if (!main) {
    throw new Error("Project main worktree was not found.");
  }
  try {
    const status = await githubFetchAndSync(main.id);
    return status.behind > 0 ? { id: main.id, behind: status.behind } : null;
  } catch {
    return null;
  }
}
