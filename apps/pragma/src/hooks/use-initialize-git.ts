import { useCallback, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import { initProjectGit } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

/**
 * Initializes a git repository for a plain project and reloads it in place.
 * The project and its root worktree keep their ids, so open tabs, agent
 * sessions and statuses are untouched — only git features switch on.
 */
export function useInitializeGit(): {
  initializing: boolean;
  /** Resolves `true` once the project is a git project, `false` on failure (already toasted). */
  initialize: (projectId: string) => Promise<boolean>;
} {
  const workspace = useWorkspace();
  const [initializing, setInitializing] = useState(false);
  const initialize = useCallback(
    async (projectId: string) => {
      setInitializing(true);
      try {
        await initProjectGit(projectId);
        await workspace.reload();
        await workspace.refreshProject(projectId);
        toast.success("Initialized a git repository");
        return true;
      } catch (cause) {
        toast.error(errorMessage(cause));
        return false;
      } finally {
        setInitializing(false);
      }
    },
    [workspace],
  );
  return { initializing, initialize };
}
