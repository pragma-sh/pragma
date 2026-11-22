import { useEffect, useRef } from "react";

import {
  consumeProjectAdded,
  PROJECT_SWITCH_SETTLE_MS,
  runProjectSwitchScripts,
} from "@/lib/project-scripts";

/**
 * Runs the global `scripts.project.switch` commands when the selection moves
 * from one project to another and rests there.
 *
 * The first project selected (restoring the last session on launch) is not a
 * switch, and neither is landing on a project that was just added. The
 * "previous" project is the one the selection last *settled* on, so cycling
 * A → B → C reports leaving A, and A → B → A runs nothing.
 */
export function useProjectSwitchScripts(selectedProjectId: string | null): void {
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProjectId) return;
    const settled = settledRef.current;
    if (settled === null || consumeProjectAdded(selectedProjectId)) {
      settledRef.current = selectedProjectId;
      return;
    }
    if (settled === selectedProjectId) return;
    const timer = setTimeout(() => {
      settledRef.current = selectedProjectId;
      void runProjectSwitchScripts(selectedProjectId, settled);
    }, PROJECT_SWITCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [selectedProjectId]);
}
