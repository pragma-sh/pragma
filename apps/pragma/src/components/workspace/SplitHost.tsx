import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import type { Tab } from "@pragma/constants";
import { Globe, Plus, SquareTerminal, X } from "lucide-react";

import { BrowserView } from "@/components/browser/BrowserView";
import { DiffView } from "@/components/editor/DiffView";
import { EditorView } from "@/components/editor/EditorView";
import { LogView } from "@/components/editor/LogView";
import { ReviewTab } from "@/components/github/ReviewTab";
import { PluginWebViewTab } from "@/plugins/PluginWebViewTab";
import { Button } from "@/components/ui/button";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TerminalView } from "@/components/terminal/TerminalView";
import { useConfirmClose } from "@/components/editor/confirm-close";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import { type DropTarget, dropTargetAt, TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { browserFocus } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";
import { type SplitLayoutNode, type SplitPaneNode, useWorkspace } from "@/state/workspace-context";

export function SplitHost() {
  const workspace = useWorkspace();
  const tabsById = useMemo(
    () => new Map(workspace.tabs.map((tab) => [tab.id, tab])),
    [workspace.tabs],
  );
  const worktreePathById = useMemo(() => {
    const paths = new Map<string, string>();
    for (const worktree of Object.values(workspace.worktrees).flat()) {
      paths.set(worktree.id, worktree.path);
    }
    return paths;
  }, [workspace.worktrees]);

  if (!workspace.splitRoot) {
    return null;
  }

  return (
    <div className="min-h-0 flex-1 bg-canvas">
      <SplitNode
        node={workspace.splitRoot}
        showPaneBars={workspace.splitRoot.kind === "split"}
        tabsById={tabsById}
        worktreePathById={worktreePathById}
      />
    </div>
  );
}

function SplitNode({
  node,
  showPaneBars,
  tabsById,
  worktreePathById,
}: {
  node: SplitLayoutNode;
  showPaneBars: boolean;
  tabsById: Map<string, Tab>;
  worktreePathById: Map<string, string>;
}) {
  if (node.kind === "pane") {
    return (
      <SplitPane
        pane={node}
        showPaneBars={showPaneBars}
        tabsById={tabsById}
        worktreePathById={worktreePathById}
      />
    );
  }

  return (
    <ResizablePanelGroup className="min-h-0" orientation={node.direction}>
      <ResizablePanel minSize={15}>
        <SplitNode
          node={node.children[0]}
          showPaneBars={showPaneBars}
          tabsById={tabsById}
          worktreePathById={worktreePathById}
        />
      </ResizablePanel>
      <ResizableHandle className="bg-border" withHandle />
      <ResizablePanel minSize={15}>
        <SplitNode
          node={node.children[1]}
          showPaneBars={showPaneBars}
          tabsById={tabsById}
          worktreePathById={worktreePathById}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/** Render the content for a pane's active tab keyed by its kind. */
const PANE_CONTENT_RENDERERS: Partial<Record<Tab["kind"], (tab: Tab, cwd: string) => ReactNode>> = {
  browser: (tab) => <BrowserView active key={tab.id} tab={tab} />,
  editor: (tab) => <EditorView key={tab.id} tab={tab} />,
  diff: (tab) => <DiffView key={tab.id} tab={tab} />,
  log: (tab) => <LogView key={tab.id} tab={tab} />,
  "pr-review": (tab) => <ReviewTab key={tab.id} tab={tab} />,
  "plugin-webview": (tab) => <PluginWebViewTab key={tab.id} tab={tab} />,
};

/** Render a pane's active tab, defaulting unknown kinds to a terminal view. */
function renderActiveTab(activeTab: Tab, cwd: string): ReactNode {
  const render = PANE_CONTENT_RENDERERS[activeTab.kind];
  if (render) return render(activeTab, cwd);
  return <TerminalView cwd={cwd} key={activeTab.id} tab={activeTab} />;
}

/** Focus/activate the active tab's surface when a pane receives focus. */
function activatePaneTab(activeTab: Tab): void {
  if (activeTab.kind === "terminal") {
    terminalManager.activate(activeTab.id);
    return;
  }
  if (activeTab.kind === "browser") {
    void browserFocus(activeTab.id).catch(() => undefined);
  }
}

/** Resolve a pane's tabs in order, dropping any ids whose tab has vanished. */
function resolvePaneTabs(pane: SplitPaneNode, tabsById: Map<string, Tab>): Tab[] {
  return pane.tabIds.flatMap((tabId) => {
    const tab = tabsById.get(tabId);
    return tab ? [tab] : [];
  });
}

/** Resolve the cwd for a pane's active tab (worktree path, else selection, home). */
function resolvePaneCwd(
  activeTab: Tab | null,
  worktreePathById: Map<string, string>,
  selectedWorktreePath: string | undefined,
): string {
  if (!activeTab) return "~";
  return worktreePathById.get(activeTab.worktreeId) ?? selectedWorktreePath ?? "~";
}

/** Border class for a pane: highlighted when focused within a split. */
function paneBorderClass(showBar: boolean, focused: boolean): string {
  if (!showBar) return "border-transparent";
  return focused ? "border-primary/35" : "border-border";
}

function SplitPane({
  pane,
  showPaneBars,
  tabsById,
  worktreePathById,
}: {
  pane: SplitPaneNode;
  showPaneBars: boolean;
  tabsById: Map<string, Tab>;
  worktreePathById: Map<string, string>;
}) {
  const workspace = useWorkspace();
  const { isDragging, draggingTabId } = useTabDrag();
  const tabs = useMemo(() => resolvePaneTabs(pane, tabsById), [pane, tabsById]);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === pane.activeTabId) ?? tabs[0] ?? null,
    [tabs, pane.activeTabId],
  );
  const focused = workspace.focusedPaneId === pane.id;
  const showBar = showPaneBars;
  const cwd = useMemo(
    () => resolvePaneCwd(activeTab, worktreePathById, workspace.selectedWorktree?.path),
    [activeTab, worktreePathById, workspace.selectedWorktree?.path],
  );

  const handlePointerDown = useCallback(() => workspace.focusPane(pane.id), [workspace, pane.id]);
  const handleSplitDrop = useCallback(
    (tabId: string, target: DropTarget) =>
      workspace.splitTabAtPane(tabId, pane.id, target.direction, target.placement),
    [workspace, pane.id],
  );

  useEffect(() => {
    if (!focused || !activeTab) return;
    activatePaneTab(activeTab);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the active tab's id/kind, not the per-render `activeTab` object identity.
  }, [activeTab?.id, activeTab?.kind, focused]);

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col border bg-canvas",
        paneBorderClass(showBar, focused),
      )}
      onPointerDown={handlePointerDown}
    >
      {showBar && <PaneBar activeTabId={activeTab?.id ?? null} pane={pane} tabs={tabs} />}
      <div className="relative min-h-0 flex-1">
        {activeTab ? renderActiveTab(activeTab, cwd) : null}
        {isDragging && <PaneDropZone draggingTabId={draggingTabId} onDrop={handleSplitDrop} />}
      </div>
    </section>
  );
}

function PaneBar({
  activeTabId,
  pane,
  tabs,
}: {
  activeTabId: string | null;
  pane: SplitPaneNode;
  tabs: Tab[];
}) {
  const workspace = useWorkspace();
  const requestClose = useConfirmClose();
  const { isDragging, draggingTabId, beginTabDrag, endTabDrag } = useTabDrag();
  const [dropActive, setDropActive] = useState(false);

  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-elevated px-1.5",
        dropActive ? "border-primary/60 bg-primary/10" : "border-border",
      )}
      onDragOver={(event) => {
        if (!isDragging) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!draggingTabId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        workspace.moveTabToPane(draggingTabId, pane.id);
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            className={cn(
              "group flex h-6 min-w-24 max-w-44 items-center gap-1 rounded-md border px-1.5 text-xs",
              active
                ? "border-border bg-elevated text-foreground"
                : "text-muted-foreground border-transparent hover:bg-muted",
            )}
            draggable
            key={tab.id}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              event.dataTransfer.effectAllowed = "move";
              beginTabDrag(tab.id);
            }}
            onDragEnd={endTabDrag}
          >
            <button
              className="flex h-full min-w-0 flex-1 items-center gap-1 text-left"
              onClick={(event) => {
                event.stopPropagation();
                workspace.setPaneActiveTab(pane.id, tab.id);
              }}
            >
              <TabIcon tab={tab} />
              <TabAgentDot tabId={tab.id} />
              <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
            </button>
            <TabDirtyDot tabId={tab.id} />
            <button
              aria-label="Close tab"
              className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                requestClose(tab);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="New tab in pane"
            className="size-6 shrink-0"
            size="icon-sm"
            variant="ghost"
          >
            <Plus className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => void workspace.createTabInPane(pane.id, "terminal")}>
            <SquareTerminal />
            Terminal
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void workspace.createTabInPane(pane.id, "browser")}>
            <Globe />
            Browser
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  return <AgentStatusDot status={useTabAgentStatus(tabId)} />;
}

/**
 * Transparent overlay shown over a pane's content while a tab is being dragged.
 * It receives the drag (native browser overlays are hidden during the drag, so
 * the drop reaches here) and previews where the tab will land. The dragged tab
 * id comes from shared drag state, since WebKit withholds `dataTransfer` data
 * until the drop fires.
 */
function PaneDropZone({
  draggingTabId,
  onDrop,
}: {
  draggingTabId: string | null;
  onDrop: (tabId: string, target: DropTarget) => void;
}) {
  const [target, setTarget] = useState<DropTarget | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-0 z-20"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        setTarget(dropTargetAt(rect, event.clientX, event.clientY));
      }}
      onDragLeave={(event) => {
        // Ignore leave events bubbling from the highlight child.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setTarget(null);
      }}
      onDrop={(event) => {
        const current = target;
        setTarget(null);
        if (!draggingTabId || !current) {
          return;
        }
        event.preventDefault();
        onDrop(draggingTabId, current);
      }}
    >
      {target ? (
        <div
          className="pointer-events-none absolute rounded-md border-2 border-primary/70 bg-primary/15 transition-all duration-75"
          style={{
            left: target.highlight.left,
            top: target.highlight.top,
            right: target.highlight.right,
            bottom: target.highlight.bottom,
          }}
        />
      ) : null}
    </div>
  );
}
