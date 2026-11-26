import { useEffect, useRef } from "react";
import type { CiWatch } from "@pragma-sh/constants";
import { toast } from "sonner";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import {
  GITHUB_PR_REFRESH_INTERVAL_MS,
  findPullRequestForBranch,
  getCheckFailureDetails,
  getChecksStatus,
  getPullRequest,
} from "@/lib/github";
import { clearCiWatch, githubRepoRef, updateCiWatch } from "@/lib/tauri";
import { loadProjectAgent } from "@/plugins/agents";
import { ciWatches, type CiWatchEffects } from "@/state/ci-watch-store";
import { useWorkspace } from "@/state/workspace-context";
import { listAllCiWatches, locateWatch, prepareMerge } from "./ci-watch-effects";

function notify(kind: "merged" | "failed", record: CiWatch): void {
  const pr = record.prNumber ? `#${record.prNumber}` : "the pull request";
  if (kind === "merged") toast.success(`Checks passed — merged ${pr}`);
  else toast.error(`CI watch for ${pr} stopped`, { description: record.error ?? undefined });
}

/** Keeps host CI watches moving across sidebar, project, and tab changes. */
export function CiWatchMonitor() {
  const workspace = useWorkspace();
  const latest = useRef(workspace);
  latest.current = workspace;
  useEffect(() => {
    const effects: CiWatchEffects = {
      list: () => listAllCiWatches(latest.current.projects),
      repoFor: (worktreeId) => githubRepoRef(worktreeId),
      findPr: (repo) => findPullRequestForBranch(repo, { force: true }),
      getPr: (repo, prNumber) => getPullRequest(repo, prNumber, { force: true }),
      getChecks: (repo, sha) => getChecksStatus(repo, sha, { force: true }),
      getDetails: (repo, checks) => getCheckFailureDetails(repo, checks),
      agentFor: async (record) => {
        const location = await locateWatch(latest.current.projects, record);
        return location ? loadProjectAgent(location.project, record.agentId) : null;
      },
      launch: async (record, agent, prompt) => {
        const location = await locateWatch(latest.current.projects, record);
        if (!location) return null;
        return latest.current.startSession(
          record.worktreeId,
          agent,
          prompt,
          { modelId: record.modelId ?? null, reasoningId: record.reasoningId ?? null },
          {
            focus: false,
            projectId: location.project.id,
            worktreePath: location.worktree.path,
          },
        );
      },
      close: (tabId) => latest.current.closeTab(tabId),
      prepareMerge,
      update: updateCiWatch,
      clear: async (worktreeId, watchId) => {
        const { cleared } = await clearCiWatch(worktreeId, watchId);
        if (cleared) ciWatches.remove(worktreeId);
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
