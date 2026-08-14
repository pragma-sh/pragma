import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { useRequiredContext } from "@/lib/context";
import { useCollapsiblePanel, type CollapsiblePanelState } from "@/hooks/use-collapsible-panel";
import { layoutBreakpoints } from "@/lib/responsive";

export type BuiltinRightSidebarSubtab = "files" | "changes" | "pullRequest";
export type PluginRightSidebarSubtab = `plugin:${string}:${string}`;
export type RightSidebarSubtab = BuiltinRightSidebarSubtab | PluginRightSidebarSubtab;

interface RightSidebarContextValue extends CollapsiblePanelState {
  activeSubtab: RightSidebarSubtab;
  setActiveSubtab: (subtab: RightSidebarSubtab) => void;
}

const RightSidebarContext = createContext<RightSidebarContextValue | null>(null);

const SUBTAB_KEY = "pragma.rightSidebar.subtab";

const panelOptions = {
  collapsedKey: "pragma.rightSidebar.collapsed",
  widthKey: "pragma.rightSidebar.width",
  defaultWidth: 360,
  minWidth: 360,
  maxWidth: 560,
  autoCollapseBelow: layoutBreakpoints.rightSidebar,
} as const;

/** Narrows a stored string to a known subtab, or null for the default fallback. */
function parseSubtab(raw: string): RightSidebarSubtab | null {
  if (raw === "changes" || raw === "pullRequest" || raw === "files") {
    return raw;
  }
  return raw.startsWith("plugin:") ? (raw as PluginRightSidebarSubtab) : null;
}

function readSubtab(): RightSidebarSubtab {
  try {
    const raw = localStorage.getItem(SUBTAB_KEY);
    return (raw === null ? null : parseSubtab(raw)) ?? "files";
  } catch {
    return "files";
  }
}

/**
 * Cosmetic state for the right sidebar (collapsed, active subtab, width),
 * persisted per device and auto-collapsed on a narrow window. The collapse and
 * width halves are shared with the left sidebar through `useCollapsiblePanel`.
 */
export function RightSidebarProvider({ children }: { children: ReactNode }) {
  const panel = useCollapsiblePanel(panelOptions);
  const [activeSubtab, setActiveSubtabState] = useState<RightSidebarSubtab>(readSubtab);

  const setActiveSubtab = useCallback((subtab: RightSidebarSubtab) => {
    setActiveSubtabState(subtab);
    try {
      localStorage.setItem(SUBTAB_KEY, subtab);
    } catch {
      // Cosmetic state only; ignore storage failures.
    }
  }, []);

  const value = useMemo<RightSidebarContextValue>(
    () => ({ ...panel, activeSubtab, setActiveSubtab }),
    [panel, activeSubtab, setActiveSubtab],
  );

  return <RightSidebarContext.Provider value={value}>{children}</RightSidebarContext.Provider>;
}

/** Accesses the right sidebar's cosmetic state. */
export function useRightSidebar(): RightSidebarContextValue {
  return useRequiredContext(RightSidebarContext, "useRightSidebar");
}
