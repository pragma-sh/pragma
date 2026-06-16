import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type RightSidebarSubtab = "files" | "changes";

interface RightSidebarContextValue {
  collapsed: boolean;
  activeSubtab: RightSidebarSubtab;
  width: number;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setActiveSubtab: (subtab: RightSidebarSubtab) => void;
  setWidth: (width: number) => void;
}

const RightSidebarContext = createContext<RightSidebarContextValue | null>(null);

const COLLAPSED_KEY = "pragma.rightSidebar.collapsed";
const SUBTAB_KEY = "pragma.rightSidebar.subtab";
const WIDTH_KEY = "pragma.rightSidebar.width";

const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const MAX_WIDTH = 560;

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
 * Cosmetic state for the right sidebar (collapsed, active subtab, width).
 * Persisted to `localStorage` rather than the backend — it's per-device UI
 * preference, not workspace data, so it never touches SQLite or the reducer.
 */
export function RightSidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(() =>
    readStored(COLLAPSED_KEY, (raw) => raw === "true", false),
  );
  const [activeSubtab, setActiveSubtabState] = useState<RightSidebarSubtab>(() =>
    readStored(SUBTAB_KEY, (raw) => (raw === "changes" ? "changes" : "files"), "files"),
  );
  const [width, setWidthState] = useState(() =>
    readStored(
      WIDTH_KEY,
      (raw) => {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      },
      DEFAULT_WIDTH,
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

  const setActiveSubtab = useCallback((subtab: RightSidebarSubtab) => {
    setActiveSubtabState(subtab);
    writeStored(SUBTAB_KEY, subtab);
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next)));
    setWidthState(clamped);
    writeStored(WIDTH_KEY, String(clamped));
  }, []);

  const value = useMemo<RightSidebarContextValue>(
    () => ({
      collapsed,
      activeSubtab,
      width,
      setCollapsed,
      toggleCollapsed,
      setActiveSubtab,
      setWidth,
    }),
    [collapsed, activeSubtab, width, setCollapsed, toggleCollapsed, setActiveSubtab, setWidth],
  );

  return <RightSidebarContext.Provider value={value}>{children}</RightSidebarContext.Provider>;
}

/** Accesses the right sidebar's cosmetic state. */
export function useRightSidebar(): RightSidebarContextValue {
  const context = useContext(RightSidebarContext);
  if (!context) {
    throw new Error("useRightSidebar must be used inside RightSidebarProvider");
  }
  return context;
}
