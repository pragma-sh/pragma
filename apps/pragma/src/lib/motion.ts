import { useReducedMotion, type Transition, type Variants } from "motion/react";

/**
 * Shared motion vocabulary for the desktop UI. Every animated component pulls
 * its timing from here so the app moves as one system rather than as a pile of
 * one-off durations — the same reason colors live in `index.css` and
 * cross-boundary values live in `@pragma/constants`.
 *
 * OS-level "reduce motion" is honoured in two places, and both are required:
 * `<MotionConfig reducedMotion="user">` in `App.tsx` strips transform and layout
 * animations globally, and {@link useMotionTransition} flattens the transitions
 * this file exposes for properties MotionConfig cannot strip (width, height).
 * CSS-driven animation is handled by the `prefers-reduced-motion` block in
 * `index.css`.
 */

/** Timing scale, in seconds. Desktop chrome stays under ~0.3s so it never reads as lag. */
const motionDuration = {
  /** Hover/press feedback. */
  instant: 0.1,
  /** Small element enter/exit (dots, badges, indicators). */
  fast: 0.14,
  /** The default for panels, dialogs, and tab content. */
  base: 0.2,
  /** Reserved for the largest surfaces. */
  slow: 0.28,
} as const;

/** Easing curves. `standard` decelerates into place; `exit` accelerates away. */
const motionEase = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/** Named transitions. Prefer these over inline `{ duration }` objects. */
export const motionTransition = {
  fast: { duration: motionDuration.fast, ease: motionEase.standard },
  base: { duration: motionDuration.base, ease: motionEase.standard },
  exit: { duration: motionDuration.fast, ease: motionEase.exit },
  /** Sidebars and other resizable panels: settles quickly, never overshoots visibly. */
  panel: { type: "spring", stiffness: 520, damping: 44, mass: 0.9 },
  /** The sliding active-tab indicator: snappier than a panel, still springy. */
  indicator: { type: "spring", stiffness: 620, damping: 46, mass: 0.7 },
  /** Small elements popping into existence (status dots). */
  pop: { type: "spring", stiffness: 700, damping: 30, mass: 0.5 },
} satisfies Record<string, Transition>;

/** A transition that completes immediately — the reduced-motion substitute. */
export const instantTransition: Transition = { duration: 0 };

/**
 * Flattens a transition to zero duration when the OS asks for reduced motion.
 *
 * Only needed for non-transform properties (`width`, `height`, `flexBasis`):
 * `MotionConfig reducedMotion="user"` already neutralizes transform and layout
 * animations, but it deliberately lets other values keep animating.
 */
export function useMotionTransition(transition: Transition): Transition {
  return useReducedMotion() ? instantTransition : transition;
}

/**
 * How long a modal takes to leave. Longer than it takes to arrive: an entrance
 * should feel immediate, but a shrink the user is meant to *see* needs room.
 */
const MODAL_EXIT_DURATION = 0.24;

/**
 * Each modal variant carries its own transition, because entering and leaving
 * need opposite easing and a variant's transition beats the component's
 * `transition` prop.
 *
 * `standard` decelerates hard — roughly 80% of the change lands in the first
 * quarter of the duration. That is right on the way in and wrong on the way out:
 * it drops opacity to nearly zero before the shrink has visibly started, so a
 * dismissal reads as a blink. Exits therefore use `exit`, which accelerates and
 * keeps the card legible while it recedes.
 */
const modalEnterTransition: Transition = {
  duration: motionDuration.base,
  ease: motionEase.standard,
};
const modalExitTransition: Transition = {
  duration: MODAL_EXIT_DURATION,
  ease: motionEase.exit,
};

/** Overlay scrim behind a modal. Matches the card's timing so neither outruns the other. */
export const scrimVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: modalEnterTransition },
  exit: { opacity: 0, transition: modalExitTransition },
};

/**
 * Modal card. Opening grows slightly into place; closing shrinks well past where
 * it ever grew, so a dismissal reads as the dialog receding rather than blinking out.
 */
export const modalVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: modalEnterTransition },
  exit: { opacity: 0, scale: 0.82, transition: modalExitTransition },
};

/** Content swapped in behind a tab strip, sliding from the direction of travel. */
export function tabPanelVariants(direction: number): Variants {
  return {
    hidden: { opacity: 0, x: direction * 12 },
    visible: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: direction * -12 },
  };
}

/**
 * Disclosure content (collapsibles, accordions). Height carries the motion;
 * opacity is deliberately faster on the way in so text is not readable while the
 * box is still growing under it.
 */
const disclosureVariants: Variants = {
  collapsed: {
    height: 0,
    opacity: 0,
    transition: {
      height: { duration: motionDuration.base, ease: motionEase.standard },
      opacity: { duration: motionDuration.instant, ease: motionEase.exit },
    },
  },
  expanded: {
    height: "auto",
    opacity: 1,
    transition: {
      height: { duration: motionDuration.base, ease: motionEase.standard },
      opacity: { duration: motionDuration.base, ease: motionEase.standard, delay: 0.04 },
    },
  },
};

const instantDisclosureVariants: Variants = {
  collapsed: { height: 0, opacity: 0, transition: instantTransition },
  expanded: { height: "auto", opacity: 1, transition: instantTransition },
};

/**
 * Disclosure variants for the current motion preference. `height` is not a
 * transform, so `MotionConfig reducedMotion="user"` leaves it animating — this
 * swaps in a zero-duration set instead.
 */
export function useDisclosureVariants(): Variants {
  return useReducedMotion() ? instantDisclosureVariants : disclosureVariants;
}

/** A tab entering or leaving a tab strip. */
export const tabItemVariants: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.85 },
};
