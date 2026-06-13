import { useRef } from "react";

import { useWorkspace } from "@/state/workspace-context";

const WHEEL_THRESHOLD = 42;
const SWIPE_THRESHOLD = 60;
/**
 * A gesture ends once the wheel stays quiet this long. Trackpad momentum keeps
 * firing events (~16ms apart) after the fingers lift, so resetting this timer on
 * every event keeps the gesture alive for the whole flick.
 */
const WHEEL_GESTURE_QUIET_MS = 150;
/**
 * Once a swipe's magnitude has fallen below this fraction of its peak, momentum
 * is clearly underway (fingers have lifted). A *rise* past that point can only
 * come from a new finger push, so it marks a separate swipe — independent of how
 * hard either swipe was. A normal flick's accel/decel stays above this line, so
 * its own pulses don't false-trigger.
 */
const WHEEL_MOMENTUM_DECAY_FRACTION = 0.6;
/** Magnitude jitter (px) to ignore when deciding whether the wheel is rising. */
const WHEEL_RISE_TOLERANCE = 4;

/** Provides project cycling driven by horizontal wheel or touch swipe gestures. */
export function useProjectCycle() {
  const workspace = useWorkspace();
  const wheelTotal = useRef(0);
  const wheelSign = useRef<1 | -1 | 0>(0);
  /** True once the current swipe has already moved a project. */
  const wheelSwitched = useRef(false);
  /** Largest event magnitude seen since the current swipe started moving. */
  const wheelPeak = useRef(0);
  const lastWheelMagnitude = useRef(0);
  const wheelGestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchSwitched = useRef(false);

  function resetWheelGesture() {
    wheelTotal.current = 0;
    wheelSign.current = 0;
    wheelSwitched.current = false;
    wheelPeak.current = 0;
    lastWheelMagnitude.current = 0;
    wheelGestureTimer.current = null;
  }

  /** Begin a fresh swipe step in the same direction (a new push mid-momentum). */
  function startWheelStep() {
    wheelTotal.current = 0;
    wheelSwitched.current = false;
    wheelPeak.current = 0;
  }

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
    if (horizontal === 0) {
      return;
    }

    const magnitude = Math.abs(horizontal);
    const sign = Math.sign(horizontal) as 1 | -1;

    // Any event (including momentum) defers the end of the gesture.
    if (wheelGestureTimer.current) {
      clearTimeout(wheelGestureTimer.current);
    }

    // A direction reversal is unambiguous new intent — switch the other way now.
    if (wheelSign.current !== 0 && sign !== wheelSign.current) {
      resetWheelGesture();
    }

    // A separate swipe in the same direction: after this swipe has moved and its
    // momentum has decayed below the threshold fraction of its peak, a rise in
    // magnitude can only be a new finger push. Compare against the prior event's
    // values, before they're updated below.
    const momentumDecayed =
      wheelSwitched.current && magnitude < wheelPeak.current * WHEEL_MOMENTUM_DECAY_FRACTION;
    const rose = magnitude > lastWheelMagnitude.current + WHEEL_RISE_TOLERANCE;
    if (momentumDecayed && rose) {
      startWheelStep();
    }

    if (wheelSign.current === 0) {
      wheelSign.current = sign;
    }
    wheelPeak.current = Math.max(wheelPeak.current, magnitude);
    lastWheelMagnitude.current = magnitude;
    wheelGestureTimer.current = setTimeout(resetWheelGesture, WHEEL_GESTURE_QUIET_MS);

    // Already moved this step: ignore the rest of the swipe and its momentum.
    if (wheelSwitched.current) {
      return;
    }

    wheelTotal.current += horizontal;
    if (Math.abs(wheelTotal.current) > WHEEL_THRESHOLD) {
      switchBy(sign);
      wheelSwitched.current = true;
    }
  }

  function onTouchStart(event: React.TouchEvent) {
    if (event.touches.length !== 1) {
      return;
    }
    touchStartX.current = event.touches[0]!.clientX;
    touchSwitched.current = false;
  }

  function onTouchEnd(event: React.TouchEvent) {
    if ((event.touches?.length ?? 0) > 0 || touchStartX.current == null) {
      return;
    }
    if (touchSwitched.current) {
      touchStartX.current = null;
      return;
    }
    const endX = event.changedTouches[0]?.clientX;
    if (endX == null) {
      return;
    }
    const deltaX = endX - touchStartX.current;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) {
      return;
    }
    touchStartX.current = null;
    touchSwitched.current = true;
    // Swipe left (negative delta) moves to the next project; right moves back.
    switchBy(deltaX < 0 ? 1 : -1);
  }

  return { switchBy, onWheel, onTouchStart, onTouchEnd };
}
