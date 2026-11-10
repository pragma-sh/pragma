import { useEffect, useRef } from "react";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import {
  GITHUB_PR_REFRESH_INTERVAL_MS,
  getCheckFailureDetails,
  getChecksStatus,
  getPullRequest,
} from "@/lib/github";
import { ciWatches, type CiWatchEffects } from "@/state/ci-watch-store";
import { useWorkspace } from "@/state/workspace-context";

/** Keeps configured watches alive across sidebar, project, and tab changes. */
export function CiWatchMonitor() {
  const workspace = useWorkspace();
  const latest = useRef(workspace);
  latest.current = workspace;
  useEffect(() => {
    const effects: CiWatchEffects = {
      getPr: (watch) => getPullRequest(watch.repo, watch.prNumber, { force: true }),
      getChecks: (watch, sha) => getChecksStatus(watch.repo, sha, { force: true }),
      getDetails: (watch, checks) => getCheckFailureDetails(watch.repo, checks),
      launch: (watch, prompt) =>
        latest.current.startSession(watch.worktreeId, watch.agent, prompt, watch.modelSelection, {
          focus: false,
        }),
      close: (tabId) => latest.current.closeTab(tabId),
    };
    const refresh = () => ciWatches.refresh(effects);
    const unsubscribe = ciWatches.subscribe(() => void refresh());
    const stop = startRefreshLoop(refresh, GITHUB_PR_REFRESH_INTERVAL_MS, { whileHidden: true });
    return () => {
      unsubscribe();
      stop();
    };
  }, []);
  return null;
}
