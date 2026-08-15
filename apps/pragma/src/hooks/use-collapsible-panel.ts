import { useCallback, useEffect, useMemo, useState } from "react";

import { useViewportNarrowerThan } from "@/hooks/use-viewport-narrower-than";

/** Persisted, resizable, auto-collapsing state for one edge panel. */
export interface CollapsiblePanelState {
  collapsed: boolean;
  width: number;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setWidth: (width: number) => void;
}

export interface CollapsiblePanelOptions {
  /** `localStorage` key holding the user's own collapsed choice. */
  collapsedKey: string;
  /** `localStorage` key holding the panel's expanded width, in px. */
  widthKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Viewport width below which the panel collapses on its own, in px. */
  autoCollapseBelow: number;
}

function readStored<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Cosmetic state only; ignore storage failures.
  }
}

function parseWidth(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cosmetic state shared by the left and right sidebars: a persisted
 * collapsed flag, a persisted drag width, and an automatic collapse once the
 * window is too narrow to hold the panel and a usable centre pane.
 *
 * The automatic collapse never overwrites the stored preference — it is an
 * overlay on top of it. Toggling the panel by hand while the window is narrow
 * takes precedence for as long as it stays narrow, so a user who wants the
 * panel in a small window keeps it; crossing the breakpoint in either
 * direction drops that override and lets the window size decide again.
 *
 * Persisted to `localStorage` rather than the backend: it is a per-device UI
 * preference, not workspace data, so it never touches SQLite or the reducer.
 */
export function useCollapsiblePanel(options: CollapsiblePanelOptions): CollapsiblePanelState {
  const { collapsedKey, widthKey, defaultWidth, minWidth, maxWidth, autoCollapseBelow } = options;
  const clampWidth = useCallback(
    (width: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(width))),
    [minWidth, maxWidth],
  );

  const [storedCollapsed, setStoredCollapsed] = useState(() =>
    readStored(collapsedKey, (raw) => raw === "true", false),
  );
  const [width, setWidthState] = useState(() =>
    clampWidth(readStored(widthKey, parseWidth, defaultWidth)),
  );
  const narrow = useViewportNarrowerThan(autoCollapseBelow);
  // Set when the user overrides the automatic collapse; cleared whenever the
  // window crosses the breakpoint so the next resize starts from a clean slate.
  const [manualOverride, setManualOverride] = useState(false);
  useEffect(() => setManualOverride(false), [narrow]);

  const setCollapsed = useCallback(
    (next: boolean) => {
      setStoredCollapsed(next);
      writeStored(collapsedKey, String(next));
      if (narrow) {
        setManualOverride(true);
      }
    },
    [collapsedKey, narrow],
  );

  const collapsed = narrow && !manualOverride ? true : storedCollapsed;
  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidthState(clamped);
      writeStored(widthKey, String(clamped));
    },
    [clampWidth, widthKey],
  );

  return useMemo(
    () => ({ collapsed, width, setCollapsed, toggleCollapsed, setWidth }),
    [collapsed, width, setCollapsed, toggleCollapsed, setWidth],
  );
}
