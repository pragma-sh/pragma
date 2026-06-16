import { useRef } from "react";

import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { ChangesTab } from "@/components/right-sidebar/ChangesTab";
import { FilesTab } from "@/components/right-sidebar/FilesTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type RightSidebarSubtab, useRightSidebar } from "@/state/right-sidebar-context";

/**
 * Secondary sidebar on the right edge of the workspace, mirroring the left
 * `ProjectSidebar`. Collapses to a thin strip and hosts the Files and Changes
 * subtabs. Rendered as the last flex child of the workspace so the center pane
 * reflows when it collapses (the BrowserView ResizeObserver re-applies native
 * webview bounds automatically).
 */
export function RightSidebar() {
  const { collapsed, activeSubtab, width, toggleCollapsed, setActiveSubtab, setWidth } =
    useRightSidebar();

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-white/10 bg-[#11151b] py-2">
        <Button
          aria-label="Expand files sidebar"
          className="text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={toggleCollapsed}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightOpen />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="relative flex shrink-0 flex-col border-l border-white/10 bg-[#0b0d10]"
      style={{ width }}
    >
      <ResizeHandle onResize={setWidth} />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 pl-1 pr-2">
        <Button
          aria-label="Collapse files sidebar"
          className="text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={toggleCollapsed}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightClose />
        </Button>
        <Tabs
          className="min-w-0 flex-1"
          onValueChange={(value) => setActiveSubtab(value as RightSidebarSubtab)}
          value={activeSubtab}
        >
          <TabsList className="h-7">
            <TabsTrigger className="text-xs" value="files">
              Files
            </TabsTrigger>
            <TabsTrigger className="text-xs" value="changes">
              Changes
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeSubtab === "files" ? <FilesTab /> : <ChangesTab />}
      </div>
    </div>
  );
}

/** Left-edge drag handle that resizes the (right-anchored) sidebar. */
function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-cyan-400/40"
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) {
          return;
        }
        dragRef.current = {
          startX: event.clientX,
          startWidth: parent.getBoundingClientRect().width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        onResize(drag.startWidth + (drag.startX - event.clientX));
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
