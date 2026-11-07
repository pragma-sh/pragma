import { useEffect, useMemo, useRef } from "react";

import type { TabKind } from "@pragma-sh/constants";

import { useWorkspace } from "@/state/workspace-context";

/**
 * A string that changes exactly when a worktree's open tabs of `kind` change.
 * Opening or closing such a tab writes or removes what it shows, so it doubles
 * as a refresh signal — and unlike `projectTabs` itself it does not churn on
 * every unrelated tab in the project.
 */
export function useWorktreeTabSignature(worktreeId: string, kind: TabKind): string {
  const { projectTabs } = useWorkspace();
  return useMemo(
    () =>
      projectTabs
        .filter((tab) => tab.kind === kind && tab.worktreeId === worktreeId)
        // Titles too: renaming a board or scratchpad renames its tab.
        .map((tab) => `${tab.id}:${tab.title}`)
        .join("\0"),
    [projectTabs, kind, worktreeId],
  );
}

/** Calls `invalidate` whenever `signature` changes after mount (mount loads anyway). */
export function useInvalidateOnChange(signature: string, invalidate: () => void): void {
  const seen = useRef(signature);
  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    invalidateRef.current();
  }, [signature]);
}
