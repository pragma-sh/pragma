import type { CiWatch, GitHubRepoRef, Project, Worktree } from "@pragma-sh/constants";
import {
  getPullRequestStack,
  mergePullRequest,
  mergePullRequestStack,
  type PullRequestSummary,
} from "@/lib/github";
import { listCiWatches, listWorktrees } from "@/lib/tauri";
import type { CiWatchListing } from "@/state/ci-watch-store";

/**
 * Every registered project's records, asked of each project's own host. Reads the
 * worktrees from the client database rather than the workspace's snapshots, which
 * only cover projects visited since launch.
 */
export async function listAllCiWatches(projects: ReadonlyArray<Project>): Promise<CiWatchListing> {
  const unanswered = new Set<string>();
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const ids = (await listWorktrees(project.id)).map((worktree) => worktree.id);
      if (ids.length === 0) return [];
      try {
        return await listCiWatches(ids[0]!, ids);
      } catch {
        for (const id of ids) unanswered.add(id);
        return [];
      }
    }),
  );
  return { records: perProject.flat(), unanswered };
}

/** The project and worktree a watch belongs to, whether or not it is selected. */
export async function locateWatch(
  projects: ReadonlyArray<Project>,
  record: Pick<CiWatch, "worktreeId">,
): Promise<{ project: Project; worktree: Worktree } | null> {
  for (const project of projects) {
    // eslint-disable-next-line no-await-in-loop -- stops at the owning project.
    const worktrees = await listWorktrees(project.id);
    const worktree = worktrees.find((candidate) => candidate.id === record.worktreeId);
    if (worktree) return { project, worktree };
  }
  return null;
}

/**
 * Resolves stack membership, then returns the merge call pinned to the commit
 * whose checks passed. Null when the stack already shows a newer head. GitHub
 * pins a stack merge by its top pull request's head.
 */
export async function prepareMerge(
  repo: GitHubRepoRef,
  pr: PullRequestSummary,
): Promise<(() => Promise<void>) | null> {
  const stack = await getPullRequestStack(repo, pr.number, { force: true });
  if (!stack) return () => mergePullRequest(repo, pr.number, "merge", pr.headSha);
  const watched = stack.entries.find((entry) => entry.number === pr.number);
  if (watched && watched.headSha !== pr.headSha) return null;
  return () => mergePullRequestStack(repo, stack, stack.entries.at(-1)?.headSha);
}
