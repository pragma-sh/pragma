import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** Pixels one arrow-key press moves a resize handle. */
const KEYBOARD_STEP_PX = 40;

/** Clamp a requested height into `[min, max]` (min wins when the range is inverted). */
export function clampHeight(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Options for {@link useVerticalResize}. */
export interface VerticalResizeOptions {
  /** The current height of the resized element. */
  height: number;
  /** Smallest allowed height. */
  min: number;
  /** Largest allowed height, read at drag time (e.g. the content's natural height). */
  max: () => number;
  /** Receives every clamped height while dragging or stepping with the keyboard. */
  onResize: (height: number) => void;
}

/**
 * Props for a horizontal bar that resizes the element above it: drag with the
 * pointer (captured, so a fast drag never loses the handle), or focus it and
 * step with ↑/↓. Spread the result onto the handle element.
 */
export function useVerticalResize({ height, min, max, onResize }: VerticalResizeOptions) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const resizeTo = (value: number) => onResize(clampHeight(value, min, max()));

  return {
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": min,
    "aria-valuenow": Math.round(height),
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      drag.current = { startY: event.clientY, startHeight: height };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = drag.current;
      if (start) {
        resizeTo(start.startHeight + event.clientY - start.startY);
      }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onPointerCancel() {
      drag.current = null;
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      // Leave modified arrows alone — Cmd/Ctrl+↑/↓ belong to comment navigation.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        resizeTo(height + (event.key === "ArrowDown" ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX));
      }
    },
  };
}
