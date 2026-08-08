import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { useRequiredContext } from "@/lib/context";

interface LeftSidebarContextValue {
  collapsed: boolean;
  width: number;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setWidth: (width: number) => void;
}

const LeftSidebarContext = createContext<LeftSidebarContextValue | null>(null);

const COLLAPSED_KEY = "pragma.leftSidebar.collapsed";
const WIDTH_KEY = "pragma.leftSidebar.width";

const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
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

/**
 * Cosmetic state for the left project sidebar (collapsed, width). Persisted to
 * `localStorage` rather than the backend — it's a per-device UI preference, not
 * workspace data, mirroring `right-sidebar-context`.
 */
export function LeftSidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(() =>
    readStored(COLLAPSED_KEY, (raw) => raw === "true", false),
  );
  const [width, setWidthState] = useState(() =>
    clampWidth(
      readStored(
        WIDTH_KEY,
        (raw) => {
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : null;
        },
        DEFAULT_WIDTH,
      ),
    ),
  );

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeStored(COLLAPSED_KEY, String(next));
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((previous) => {
      const next = !previous;
      writeStored(COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    writeStored(WIDTH_KEY, String(clamped));
  }, []);

  const value = useMemo<LeftSidebarContextValue>(
    () => ({ collapsed, width, setCollapsed, toggleCollapsed, setWidth }),
    [collapsed, width, setCollapsed, toggleCollapsed, setWidth],
  );

  return <LeftSidebarContext.Provider value={value}>{children}</LeftSidebarContext.Provider>;
}

/** Accesses the left project sidebar's cosmetic state. */
export function useLeftSidebar(): LeftSidebarContextValue {
  return useRequiredContext(LeftSidebarContext, "useLeftSidebar");
}
