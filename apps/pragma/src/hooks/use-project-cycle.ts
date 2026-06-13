import { useRef } from "react";

import { useWorkspace } from "@/state/workspace-context";

const WHEEL_THRESHOLD = 42;
const SWIPE_THRESHOLD = 60;
const COOLDOWN_MS = 450;

/** Provides project cycling driven by horizontal wheel or touch swipe gestures. */
export function useProjectCycle() {
  const workspace = useWorkspace();
  const wheelTotal = useRef(0);
  const cooldownUntil = useRef(0);
  const touchStartX = useRef<number | null>(null);

  function switchBy(delta: number) {
    if (!workspace.selectedProjectId) {
      return;
    }
    const current = workspace.projects.findIndex(
      (project) => project.id === workspace.selectedProjectId,
    );
    const next = Math.max(0, Math.min(workspace.projects.length - 1, current + delta));
    if (next !== current) {
      void workspace.selectProject(workspace.projects[next]!.id);
    }
  }

  function onWheel(event: React.WheelEvent) {
    const horizontal =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.shiftKey
          ? event.deltaY
          : 0;
    if (horizontal === 0 || Date.now() < cooldownUntil.current) {
      return;
    }
    wheelTotal.current += horizontal;
    if (Math.abs(wheelTotal.current) > WHEEL_THRESHOLD) {
      switchBy(wheelTotal.current > 0 ? 1 : -1);
      wheelTotal.current = 0;
      cooldownUntil.current = Date.now() + COOLDOWN_MS;
    }
  }

  function onTouchStart(event: React.TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(event: React.TouchEvent) {
    const startX = touchStartX.current;
    if (startX == null) {
      return;
    }
    const endX = event.changedTouches[0]?.clientX;
    if (endX == null) {
      return;
    }
    touchStartX.current = null;
    const deltaX = endX - startX;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD || Date.now() < cooldownUntil.current) {
      return;
    }
    // Swipe left (negative delta) moves to the next project; right moves back.
    switchBy(deltaX < 0 ? 1 : -1);
    cooldownUntil.current = Date.now() + COOLDOWN_MS;
  }

  return { switchBy, onWheel, onTouchStart, onTouchEnd };
}
