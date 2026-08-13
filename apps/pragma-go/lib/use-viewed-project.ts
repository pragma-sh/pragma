import { useFocusEffect } from "expo-router";
import { useCallback } from "react";

import { setViewedProjectRoot } from "./viewed-project";

/**
 * Reports the focused screen's theme root: a project's main-worktree path, or
 * `null` from the projects list for the global theme alone. `undefined` means
 * "not loaded yet" and leaves the previous root in place rather than flashing
 * back to the global palette. Nothing is cleared on blur — a screen that
 * regains focus re-asserts its root, so drilling down and back never races.
 */
export function useViewedProjectRoot(root: string | null | undefined): void {
  useFocusEffect(
    useCallback(() => {
      if (root !== undefined) setViewedProjectRoot(root);
    }, [root]),
  );
}
