import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Where the tour card sits relative to its highlighted target. */
export type TourPlacement = "top" | "bottom" | "left" | "right";

export interface TourStep {
  /** Stable id, used as the React key. */
  id: string;
  /** CSS selector for the element to spotlight (typically `[data-tour="…"]`). */
  target: string;
  /** Card heading. */
  title: string;
  /** Card body. */
  description: string;
  /** Preferred side; falls back to the opposite side when it would overflow. */
  placement?: TourPlacement;
}

/** Viewport rect of the spotlighted element, in pixels. */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 6;
const CARD_GAP = 12;
const CARD_WIDTH = 320;
const VIEWPORT_MARGIN = 12;

function readRect(selector: string): Rect | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/**
 * Tracks the target's viewport rect across step changes, resizes, and scrolls.
 * Returns `null` while the element is missing so the caller can skip the step
 * rather than point at nothing.
 */
function useTargetRect(selector: string | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    const measure = () => setRect(readRect(selector));
    measure();
    // A target can mount a frame or two after the step opens (menus, lazily
    // rendered panels), so re-measure on the next frames as well.
    const timer = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [selector]);

  return rect;
}

const CARD_HEIGHT = 168;

/** Flips a side that has no room left for the card on that edge of the viewport. */
function resolveSide(rect: Rect, placement: TourPlacement): TourPlacement {
  switch (placement) {
    case "bottom":
      return rect.top + rect.height + CARD_GAP + CARD_HEIGHT < window.innerHeight
        ? "bottom"
        : "top";
    case "top":
      return rect.top - CARD_GAP - CARD_HEIGHT > 0 ? "top" : "bottom";
    case "right":
      return rect.left + rect.width + CARD_GAP + CARD_WIDTH < window.innerWidth ? "right" : "left";
    case "left":
      return rect.left - CARD_GAP - CARD_WIDTH > 0 ? "left" : "right";
  }
}

/** Keeps a coordinate inside the viewport, leaving the standard margin. */
function clamp(value: number, size: number, viewport: number): number {
  return Math.min(Math.max(value, VIEWPORT_MARGIN), viewport - size - VIEWPORT_MARGIN);
}

/** Places the card beside the rect, flipping and clamping to stay on screen. */
function cardPosition(rect: Rect, placement: TourPlacement): { top: number; left: number } {
  const side = resolveSide(rect, placement);
  const top =
    side === "bottom"
      ? rect.top + rect.height + CARD_GAP
      : side === "top"
        ? rect.top - CARD_GAP - CARD_HEIGHT
        : rect.top + rect.height / 2 - CARD_HEIGHT / 2;
  const left =
    side === "right"
      ? rect.left + rect.width + CARD_GAP
      : side === "left"
        ? rect.left - CARD_GAP - CARD_WIDTH
        : rect.left + rect.width / 2 - CARD_WIDTH / 2;

  return {
    top: clamp(top, CARD_HEIGHT, window.innerHeight),
    left: clamp(left, CARD_WIDTH, window.innerWidth),
  };
}

/**
 * A guided product tour: dims the app, spotlights one element at a time, and
 * explains it in a card anchored beside it.
 *
 * The dimming is a single element whose huge spread `box-shadow` fills the
 * viewport around the cutout, so there is no second overlay to keep in sync and
 * the highlighted control stays visible (it is not interactive while the tour
 * runs — the tour teaches where things are, it does not drive them).
 *
 * A step whose target is not in the DOM is skipped automatically, which keeps a
 * tour honest across layouts where a control is conditionally rendered.
 */
export function Tour({
  onFinish,
  open,
  steps,
}: {
  /** Called when the last step is completed, or the tour is skipped. */
  onFinish: () => void;
  open: boolean;
  steps: TourStep[];
}) {
  const [index, setIndex] = useState(0);
  const step = open ? (steps[index] ?? null) : null;
  const rect = useTargetRect(step?.target ?? null);

  const finish = useCallback(() => {
    setIndex(0);
    onFinish();
  }, [onFinish]);

  const next = useCallback(() => {
    if (index >= steps.length - 1) finish();
    else setIndex(index + 1);
  }, [finish, index, steps.length]);

  // Escape skips the tour, matching every other dismissible surface.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, open]);

  // A step pointing at an element that never appears would strand the tour, so
  // move past it once the measurement has had a chance to resolve.
  useEffect(() => {
    if (!open || !step || rect) return;
    const timer = window.setTimeout(() => {
      if (index >= steps.length - 1) finish();
      else setIndex((current) => current + 1);
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [finish, index, open, rect, step, steps.length]);

  const position = rect ? cardPosition(rect, step?.placement ?? "bottom") : null;

  return (
    <AnimatePresence>
      {step && rect && position ? (
        <motion.div
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[60]"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
        >
          {/* The cutout: the ring outlines the target, the shadow dims the rest. */}
          <motion.div
            animate={{
              top: rect.top - SPOTLIGHT_PADDING,
              left: rect.left - SPOTLIGHT_PADDING,
              width: rect.width + SPOTLIGHT_PADDING * 2,
              height: rect.height + SPOTLIGHT_PADDING * 2,
            }}
            className="pointer-events-none absolute rounded-lg ring-2 ring-primary shadow-[0_0_0_9999px_var(--overlay)]"
            initial={false}
            transition={{ duration: 0.18 }}
          />
          <section
            aria-label="Product tour"
            className={cn(
              "bg-background absolute w-80 rounded-xl border p-4 shadow-floating",
              "flex flex-col gap-3",
            )}
            style={{ top: position.top, left: position.left }}
          >
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{step.title}</h3>
              <p className="text-muted-foreground text-sm">{step.description}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs tabular-nums">
                {index + 1} of {steps.length}
              </span>
              <div className="flex items-center gap-2">
                <Button onClick={finish} size="sm" variant="ghost">
                  Skip tour
                </Button>
                <Button onClick={next} size="sm">
                  {index >= steps.length - 1 ? "Done" : "Next"}
                </Button>
              </div>
            </div>
          </section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
