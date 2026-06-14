import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface TabDragValue {
  /** A tab is currently being dragged somewhere in the workspace. */
  isDragging: boolean;
  /** The id of the tab being dragged, or null. */
  draggingTabId: string | null;
  /** Mark a tab drag as started (called from a tab's `onDragStart`). */
  beginTabDrag: (tabId: string) => void;
  /** Clear drag state (called from `onDragEnd`/`onDrop`, or a global fallback). */
  endTabDrag: () => void;
}

const defaultValue: TabDragValue = {
  isDragging: false,
  draggingTabId: null,
  beginTabDrag: () => undefined,
  endTabDrag: () => undefined,
};

const TabDragContext = createContext<TabDragValue>(defaultValue);

/**
 * Tracks the in-flight tab drag so panes can show drop zones and native browser
 * overlays can hide themselves (they would otherwise float above the drop
 * targets and swallow the drag). Provider-less consumers get an inert default so
 * components stay renderable in isolation (e.g. unit tests).
 */
export function TabDragProvider({ children }: { children: ReactNode }) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  // Drops or cancelled drags don't always surface a React `onDragEnd` (the source
  // node can unmount mid-drop), so clear from the window as a backstop.
  useEffect(() => {
    if (!draggingTabId) {
      return;
    }
    const clear = () => setDraggingTabId(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [draggingTabId]);

  const value = useMemo<TabDragValue>(
    () => ({
      isDragging: draggingTabId !== null,
      draggingTabId,
      beginTabDrag: setDraggingTabId,
      endTabDrag: () => setDraggingTabId(null),
    }),
    [draggingTabId],
  );

  return <TabDragContext.Provider value={value}>{children}</TabDragContext.Provider>;
}

/** Accesses the shared tab-drag state. */
export function useTabDrag(): TabDragValue {
  return useContext(TabDragContext);
}
