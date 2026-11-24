import { useEffect, useRef } from "react";
import type { CiWatch } from "@pragma-sh/constants";
import { toast } from "sonner";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { useAgentsList } from "@/hooks/use-agents-list";
import {
  GITHUB_PR_REFRESH_INTERVAL_MS,
  findPullRequestForBranch,
  getCheckFailureDetails,
  getChecksStatus,
  getPullRequest,
  getPullRequestStack,
  mergePullRequest,
  mergePullRequestStack,
} from "@/lib/github";
import { clearCiWatch, githubRepoRef, listCiWatches, updateCiWatch } from "@/lib/tauri";
import { ciWatches, type CiWatchEffects } from "@/state/ci-watch-store";
import { useWorkspace } from "@/state/workspace-context";

/** Every project's records, asked of each project's own host. */
async function listAllCiWatches(
  worktreesByProject: Record<string, { id: string }[]>,
): Promise<{ records: CiWatch[]; complete: boolean }> {
  const results = await Promise.allSettled(
    Object.values(worktreesByProject)
      .filter((worktrees) => worktrees.length > 0)
      .map((worktrees) =>
        listCiWatches(
          worktrees[0]!.id,
          worktrees.map((worktree) => worktree.id),
        ),
      ),
  );
  return {
    records: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    complete: results.every((result) => result.status === "fulfilled"),
  };
}

function notify(kind: "merged" | "failed", record: CiWatch): void {
  const pr = record.prNumber ? `#${record.prNumber}` : "the pull request";
  if (kind === "merged") toast.success(`Checks passed — merged ${pr}`);
  else toast.error(`CI watch for ${pr} stopped`, { description: record.error ?? undefined });
}

/** Keeps host CI watches moving across sidebar, project, and tab changes. */
export function CiWatchMonitor() {
  const workspace = useWorkspace();
  const agents = useAgentsList();
  const latest = useRef({ workspace, agents });
  latest.current = { workspace, agents };
  useEffect(() => {
    const effects: CiWatchEffects = {
      list: () => listAllCiWatches(latest.current.workspace.worktrees),
      repoFor: (worktreeId) => githubRepoRef(worktreeId),
      findPr: (repo) => findPullRequestForBranch(repo, { force: true }),
      getPr: (repo, prNumber) => getPullRequest(repo, prNumber, { force: true }),
      getChecks: (repo, sha) => getChecksStatus(repo, sha, { force: true }),
      getDetails: (repo, checks) => getCheckFailureDetails(repo, checks),
      agentFor: (record) =>
        latest.current.agents.find((agent) => agent.id === record.agentId) ?? null,
      launch: (record, agent, prompt) =>
        latest.current.workspace.startSession(
          record.worktreeId,
          agent,
          prompt,
          { modelId: record.modelId ?? null, reasoningId: record.reasoningId ?? null },
          { focus: false },
        ),
      close: (tabId) => latest.current.workspace.closeTab(tabId),
      merge: async (repo, pr) => {
        const stack = await getPullRequestStack(repo, pr.number, { force: true });
        await (stack ? mergePullRequestStack(repo, stack) : mergePullRequest(repo, pr.number));
      },
      update: updateCiWatch,
      clear: async (worktreeId) => {
        await clearCiWatch(worktreeId);
        ciWatches.remove(worktreeId);
      },
      notify,
    };
    const refresh = () => {
      void ciWatches.refresh(effects).catch(() => undefined);
    };
    ciWatches.setRefresher(refresh);
    const stop = startRefreshLoop(
      () => ciWatches.refresh(effects).catch(() => undefined),
      GITHUB_PR_REFRESH_INTERVAL_MS,
      { whileHidden: true },
    );
    return () => {
      ciWatches.setRefresher(null);
      stop();
    };
  }, []);
  return null;
}
