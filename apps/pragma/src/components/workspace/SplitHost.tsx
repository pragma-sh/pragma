import { lazy, Suspense, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import type { Tab } from "@pragma/constants";
import { Bot, Globe, Pencil, Plus, SquareTerminal, X } from "lucide-react";

import { BrowserView } from "@/components/browser/BrowserView";
import { DiffView } from "@/components/editor/DiffView";
import { EditorView } from "@/components/editor/EditorView";
import { LogView } from "@/components/editor/LogView";
import { isMarkdownPath, MarkdownView } from "@/components/editor/MarkdownView";
import { isMediaPath } from "@/components/media/media-path";
import { MediaView } from "@/components/media/MediaView";
import { isPdfPath } from "@/components/pdf/pdf-path";
import { PdfView } from "@/components/pdf/PdfView";
import { ReviewTab } from "@/components/github/ReviewTab";
import { PluginWebViewTab } from "@/plugins/PluginWebViewTab";
import { IconButton, IconTooltip } from "@/components/ui/icon-button";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentIcon } from "@/components/agents/AgentIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TerminalView } from "@/components/terminal/TerminalView";
import { useConfirmClose, useConfirmCloseTabs } from "@/components/editor/confirm-close";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import {
  type DropTarget,
  type PaneDropIntent,
  PANE_BAR_ATTR,
  PANE_ID_ATTR,
  readPaneGeometry,
  resolvePaneDropIntent,
  TAB_DRAG_TYPE,
} from "@/components/tabs/tab-drag";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { TabRenameInput } from "@/components/tabs/TabRenameInput";
import { type TabRenameApi, useTabRename } from "@/components/tabs/use-tab-rename";
import { useAgentsList } from "@/hooks/use-agents-list";
import { startAgentInTab } from "@/lib/agent-launch";
import { type AgentConfig, browserFocus } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";
import { type SplitLayoutNode, type SplitPaneNode, useWorkspace } from "@/state/workspace-context";

const ScratchpadView = lazy(() =>
  import("@/components/scratchpad/ScratchpadView").then((module) => ({
    default: module.ScratchpadView,
  })),
);

export function SplitHost() {
  const workspace = useWorkspace();
  const dropIntent = useTabDropIntent();
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
        dropIntent={dropIntent}
        node={workspace.splitRoot}
        showPaneBars={workspace.splitRoot.kind === "split"}
        tabsById={tabsById}
        worktreePathById={worktreePathById}
      />
    </div>
  );
}

function SplitNode({
  dropIntent,
  node,
  showPaneBars,
  tabsById,
  worktreePathById,
}: {
  dropIntent: PaneDropIntent | null;
  node: SplitLayoutNode;
  showPaneBars: boolean;
  tabsById: Map<string, Tab>;
  worktreePathById: Map<string, string>;
}) {
  if (node.kind === "pane") {
    return (
      <SplitPane
        dropIntent={dropIntent?.paneId === node.id ? dropIntent : null}
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
          dropIntent={dropIntent}
          node={node.children[0]}
          showPaneBars={showPaneBars}
          tabsById={tabsById}
          worktreePathById={worktreePathById}
        />
      </ResizablePanel>
      <ResizableHandle className="bg-border" withHandle />
      <ResizablePanel minSize={15}>
        <SplitNode
          dropIntent={dropIntent}
          node={node.children[1]}
          showPaneBars={showPaneBars}
          tabsById={tabsById}
          worktreePathById={worktreePathById}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * Resolves the pane under the pointer, and performs the drop, from `window` while a
 * tab drag is in flight.
 *
 * Deliberately not per-pane drag handlers: the drop zones only exist during the
 * drag, and WebKit does not reliably register an element inserted mid-drag as a drop
 * target — the preview appeared once near where the drag entered the pane and then
 * stopped updating. Window-level `dragover` always fires (it bubbles from whatever
 * is under the pointer), so resolution is pure geometry against the panes' rects and
 * never depends on hit-testing an overlay.
 */
function useTabDropIntent(): PaneDropIntent | null {
  const workspace = useWorkspace();
  const { isDragging, draggingTabId } = useTabDrag();
  const [intent, setIntent] = useState<PaneDropIntent | null>(null);

  useEffect(() => {
    if (!isDragging || !draggingTabId) {
      setIntent(null);
      return;
    }
    // The intent the release will act on. Kept in a ref as well as state because
    // `dragend` has to read it synchronously, before React re-renders.
    let current: PaneDropIntent | null = null;
    let dropped = false;

    const track = (event: DragEvent): PaneDropIntent | null => {
      current = resolvePaneDropIntent(readPaneGeometry(), event.clientX, event.clientY);
      setIntent(current);
      if (current) {
        // Claiming the drop only where it means something leaves the rest of the
        // window (sidebars, tab strip) showing a "no drop" cursor.
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
      }
      return current;
    };
    const commit = (intentToApply: PaneDropIntent | null) => {
      dropped = true;
      current = null;
      setIntent(null);
      if (!intentToApply) {
        return;
      }
      if (intentToApply.split) {
        workspace.splitTabAtPane(
          draggingTabId,
          intentToApply.paneId,
          intentToApply.split.direction,
          intentToApply.split.placement,
        );
        return;
      }
      workspace.moveTabToPane(draggingTabId, intentToApply.paneId);
    };

    const handleDrop = (event: DragEvent) => {
      const next = track(event);
      event.preventDefault();
      commit(next);
    };
    // WebKit can end a drag with `dragend` alone and no `drop` — the drop only
    // landed where the drag happened to enter a pane, and was silently swallowed
    // anywhere else. Releasing over a pane means the same thing either way, so
    // finish the move from whichever event arrives first.
    const handleDragEnd = (event: DragEvent) => {
      if (dropped) {
        return;
      }
      // Prefer the release position; a cancelled drag reports (0, 0), which lands
      // outside every pane and so commits nothing.
      const atRelease =
        event.clientX || event.clientY
          ? resolvePaneDropIntent(readPaneGeometry(), event.clientX, event.clientY)
          : current;
      commit(atRelease);
    };
    const handleCancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        current = null;
        setIntent(null);
      }
    };

    // `dragenter` must be cancelled too, not just `dragover`, or WebKit never
    // treats the position as a valid drop.
    window.addEventListener("dragenter", track);
    window.addEventListener("dragover", track);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", handleDragEnd);
    window.addEventListener("keydown", handleCancel);
    return () => {
      window.removeEventListener("dragenter", track);
      window.removeEventListener("dragover", track);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", handleDragEnd);
      window.removeEventListener("keydown", handleCancel);
    };
  }, [draggingTabId, isDragging, workspace]);

  return intent;
}

/** Pick the surface an `editor` tab opens in, keyed by the file's extension. */
function renderEditorTab(tab: Tab): ReactNode {
  if (isPdfPath(tab.filePath)) return <PdfView key={tab.id} tab={tab} />;
  if (isMediaPath(tab.filePath)) return <MediaView key={tab.id} tab={tab} />;
  if (isMarkdownPath(tab.filePath)) return <MarkdownView key={tab.id} tab={tab} />;
  return <EditorView key={tab.id} tab={tab} />;
}

/** Render the content for a pane's active tab keyed by its kind. */
const PANE_CONTENT_RENDERERS: Partial<Record<Tab["kind"], (tab: Tab, cwd: string) => ReactNode>> = {
  browser: (tab) => <BrowserView active key={tab.id} tab={tab} />,
  editor: renderEditorTab,
  scratchpad: (tab) => (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-sm text-muted-foreground">
          Loading scratchpad...
        </div>
      }
      key={tab.id}
    >
      <ScratchpadView tab={tab} />
    </Suspense>
  ),
  diff: (tab) => <DiffView key={tab.id} tab={tab} />,
  log: (tab) => <LogView key={tab.id} tab={tab} />,
  "pr-review": (tab) => <ReviewTab key={tab.id} tab={tab} />,
  "plugin-webview": (tab) => <PluginWebViewTab key={tab.id} tab={tab} />,
};

/** Render a pane's active non-terminal tab. */
function renderActiveTab(activeTab: Tab, cwd: string): ReactNode {
  const render = PANE_CONTENT_RENDERERS[activeTab.kind];
  if (render) return render(activeTab, cwd);
  return null;
}

/** Focus/activate the active tab's surface when a pane receives focus. */
function activatePaneTab(activeTab: Tab): void {
  if (activeTab.kind === "terminal") {
    terminalManager.activate(activeTab.id);
    terminalManager.focus(activeTab.id);
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

// fallow-ignore-next-line complexity -- pane focus, drag drop zones, and terminal retention share one React surface; extracting would reintroduce prop drilling across the split tree.
function SplitPane({
  dropIntent,
  pane,
  showPaneBars,
  tabsById,
  worktreePathById,
}: {
  /** Non-null only while a dragged tab is hovering this pane. */
  dropIntent: PaneDropIntent | null;
  pane: SplitPaneNode;
  showPaneBars: boolean;
  tabsById: Map<string, Tab>;
  worktreePathById: Map<string, string>;
}) {
  const workspace = useWorkspace();
  const tabs = useMemo(() => resolvePaneTabs(pane, tabsById), [pane, tabsById]);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === pane.activeTabId) ?? tabs[0] ?? null,
    [tabs, pane.activeTabId],
  );
  const [retainedTerminalIds, setRetainedTerminalIds] = useState<Set<string>>(() =>
    activeTab?.kind === "terminal" ? new Set([activeTab.id]) : new Set(),
  );
  const focused = workspace.focusedPaneId === pane.id;
  const showBar = showPaneBars;
  const cwd = useMemo(
    () => resolvePaneCwd(activeTab, worktreePathById, workspace.selectedWorktree?.path),
    [activeTab, worktreePathById, workspace.selectedWorktree?.path],
  );

  const handlePointerDown = useCallback(() => {
    workspace.focusPane(pane.id);
    if (activeTab?.kind === "terminal") {
      terminalManager.focus(activeTab.id, true);
    }
  }, [activeTab, workspace, pane.id]);

  useEffect(() => {
    if (!focused || !activeTab) return;
    activatePaneTab(activeTab);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the active tab's id/kind, not the per-render `activeTab` object identity.
  }, [activeTab?.id, activeTab?.kind, focused]);

  useEffect(() => {
    if (activeTab?.kind !== "terminal") return;
    setRetainedTerminalIds((current) => {
      if (current.has(activeTab.id)) return current;
      return new Set(current).add(activeTab.id);
    });
  }, [activeTab?.id, activeTab?.kind]);

  const retainedTerminals = tabs.filter(
    (tab) =>
      tab.kind === "terminal" && (tab.id === activeTab?.id || retainedTerminalIds.has(tab.id)),
  );

  return (
    <section
      className={cn(
        "relative flex h-full min-h-0 flex-col border bg-canvas",
        paneBorderClass(showBar, focused),
      )}
      onPointerDown={handlePointerDown}
      {...{ [PANE_ID_ATTR]: pane.id }}
    >
      {showBar && (
        <PaneBar
          activeTabId={activeTab?.id ?? null}
          mergeTargeted={dropIntent?.split === null}
          pane={pane}
          tabs={tabs}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {retainedTerminals.map((tab) => {
          const active = tab.id === activeTab?.id;
          const terminalCwd = resolvePaneCwd(
            tab,
            worktreePathById,
            workspace.selectedWorktree?.path,
          );
          return (
            <div
              aria-hidden={!active}
              className={cn("absolute inset-0", !active && "hidden")}
              key={tab.id}
            >
              <TerminalView active={active} cwd={terminalCwd} tab={tab} />
            </div>
          );
        })}
        {activeTab && activeTab.kind !== "terminal" ? renderActiveTab(activeTab, cwd) : null}
      </div>
      {/* Section-level, not content-level: a split divides the whole pane (its bar
          included), so a preview measured against the content box alone would be
          offset by the bar's height and halve the wrong rectangle. */}
      <PaneDropPreview target={dropIntent?.split ?? null} />
    </section>
  );
}

function PaneBar({
  activeTabId,
  mergeTargeted,
  pane,
  tabs,
}: {
  activeTabId: string | null;
  /** A dragged tab is over this bar, so dropping merges it into the pane. */
  mergeTargeted: boolean;
  pane: SplitPaneNode;
  tabs: Tab[];
}) {
  const requestClose = useConfirmClose();
  const requestCloseTabs = useConfirmCloseTabs();
  const { beginTabDrag, endTabDrag } = useTabDrag();
  const rename = useTabRename();

  // The drop itself is resolved from the window (see `useTabDropIntent`); the bar
  // only reports that a drop here would merge rather than split.
  return (
    <div
      className={cn(
        "relative z-30 flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-elevated px-1.5",
        mergeTargeted ? "border-primary/60 bg-primary/10" : "border-border",
      )}
      {...{ [PANE_BAR_ATTR]: "" }}
    >
      {tabs.map((tab) => (
        <PaneTab
          active={tab.id === activeTabId}
          beginTabDrag={beginTabDrag}
          endTabDrag={endTabDrag}
          key={tab.id}
          paneId={pane.id}
          rename={rename}
          requestClose={requestClose}
          tab={tab}
        />
      ))}
      <PaneNewTabMenu paneId={pane.id} />
      {/* Closing every tab in the pane collapses it, which is how a split is
          dissolved from inside the split itself. */}
      <IconButton
        aria-label="Close pane"
        className="ml-auto size-6 shrink-0"
        label="Close pane"
        onClick={(event) => {
          event.stopPropagation();
          requestCloseTabs(tabs);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

/** One tab entry in a pane bar: drag handle, inline rename, close, context menu. */
function PaneTab({
  active,
  beginTabDrag,
  endTabDrag,
  paneId,
  rename,
  requestClose,
  tab,
}: {
  active: boolean;
  beginTabDrag: (tabId: string) => void;
  endTabDrag: () => void;
  paneId: string;
  rename: TabRenameApi;
  requestClose: (tab: Tab) => void;
  tab: Tab;
}) {
  const workspace = useWorkspace();
  const displayTitle = tabTitle(tab);
  const isRenaming = tab.id === rename.renamingTabId;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group flex h-6 min-w-24 max-w-44 items-center gap-1 rounded-md border px-1.5 text-xs",
            active
              ? "border-border bg-elevated text-foreground"
              : "text-muted-foreground border-transparent hover:bg-muted",
          )}
          // A renaming tab must not be draggable: the drag gesture otherwise wins
          // over selecting text inside the input.
          draggable={!isRenaming}
          onDragStart={(event) => {
            event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
            event.dataTransfer.effectAllowed = "move";
            beginTabDrag(tab.id);
          }}
          onDragEnd={endTabDrag}
        >
          {isRenaming ? (
            <TabRenameInput className="text-xs" rename={rename} />
          ) : (
            <button
              className="flex h-full min-w-0 flex-1 items-center gap-1 text-left"
              onClick={(event) => {
                event.stopPropagation();
                workspace.setPaneActiveTab(paneId, tab.id);
                if (tab.kind === "terminal") {
                  terminalManager.focus(tab.id, true);
                }
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                rename.startRename(tab.id, displayTitle);
              }}
            >
              <TabIcon tab={tab} />
              <TabAgentDot tabId={tab.id} />
              <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
            </button>
          )}
          <TabDirtyDot tabId={tab.id} />
          <IconTooltip label="Close tab">
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
          </IconTooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => rename.startRenameFromMenu(tab.id, displayTitle)}>
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => requestClose(tab)}>
          <X />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The pane's "+" menu: a new terminal or browser tab in this pane, plus the
 * configured agents, each launched into a terminal tab of this pane.
 */
function PaneNewTabMenu({ paneId }: { paneId: string }) {
  const workspace = useWorkspace();
  const agents = useAgentsList();

  const launchAgent = useCallback(
    async (agent: AgentConfig) => {
      const tab = await workspace.createTabInPane(paneId, "terminal");
      if (!tab) {
        return;
      }
      void workspace.markTabAgent(tab.id, agent);
      startAgentInTab(tab.id, agent);
    },
    [paneId, workspace],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label="New tab in pane"
          className="size-6 shrink-0"
          label="New tab"
          size="icon-sm"
          variant="ghost"
        >
          <Plus className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => void workspace.createTabInPane(paneId, "terminal")}>
          <SquareTerminal />
          Terminal
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void workspace.createTabInPane(paneId, "browser")}>
          <Globe />
          Browser
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Bot />
            Open agent
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-52">
            {agents.length === 0 ? (
              <DropdownMenuItem disabled>No agents configured</DropdownMenuItem>
            ) : (
              agents.map((agent) => (
                <DropdownMenuItem
                  className="gap-2"
                  key={agent.id}
                  onSelect={() => void launchAgent(agent)}
                >
                  <AgentIcon agent={agent} />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  return <AgentStatusDot status={useTabAgentStatus(tabId)} />;
}

/**
 * Previews the half of the pane a dropped tab will occupy. Purely presentational and
 * never a drop target itself (`pointer-events-none`), so it can neither swallow the
 * terminal's input nor depend on WebKit hit-testing an element that appeared
 * mid-drag — the window resolves the drop instead (see `useTabDropIntent`).
 */
function PaneDropPreview({ target }: { target: DropTarget | null }) {
  if (!target) {
    return null;
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      <div
        className="absolute rounded-md border-2 border-primary/70 bg-primary/15 transition-all duration-75"
        style={{
          left: target.highlight.left,
          top: target.highlight.top,
          right: target.highlight.right,
          bottom: target.highlight.bottom,
        }}
      />
    </div>
  );
}
