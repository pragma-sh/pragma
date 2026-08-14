import { createContext, type ReactNode } from "react";
import { useRequiredContext } from "@/lib/context";
import { useCollapsiblePanel, type CollapsiblePanelState } from "@/hooks/use-collapsible-panel";
import { layoutBreakpoints } from "@/lib/responsive";

type LeftSidebarContextValue = CollapsiblePanelState;

const LeftSidebarContext = createContext<LeftSidebarContextValue | null>(null);

const panelOptions = {
  collapsedKey: "pragma.leftSidebar.collapsed",
  widthKey: "pragma.leftSidebar.width",
  defaultWidth: 288,
  minWidth: 200,
  maxWidth: 480,
  autoCollapseBelow: layoutBreakpoints.leftSidebar,
} as const;

/**
 * Cosmetic state for the left project sidebar (collapsed, width), persisted
 * per device and auto-collapsed on a narrow window. Mirrors
 * `right-sidebar-context`; both share `useCollapsiblePanel`.
 */
export function LeftSidebarProvider({ children }: { children: ReactNode }) {
  const panel = useCollapsiblePanel(panelOptions);
  return <LeftSidebarContext.Provider value={panel}>{children}</LeftSidebarContext.Provider>;
}

/** Accesses the left project sidebar's cosmetic state. */
export function useLeftSidebar(): LeftSidebarContextValue {
  return useRequiredContext(LeftSidebarContext, "useLeftSidebar");
}
