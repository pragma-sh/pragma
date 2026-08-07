import { AnimatePresence, motion } from "motion/react";
import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";
import { LayoutGrid } from "lucide-react";
import { toast } from "sonner";

import { useConfirmClose } from "@/components/editor/confirm-close";
import type { Tab } from "@pragma/constants";
import { ProjectKanbanWorkspace } from "@/components/kanban/ProjectKanbanWorkspace";
import { SettingsWorkspace } from "@/components/settings/SettingsWorkspace";
import { RightSidebar } from "@/components/right-sidebar/RightSidebar";
import { Button } from "@/components/ui/button";
import { ProjectSidebar } from "@/components/sidebar/ProjectSidebar";
import { TabDragProvider } from "@/components/tabs/tab-drag-context";
import { TerminalTabs } from "@/components/tabs/TerminalTabs";
import { SplitHost } from "@/components/workspace/SplitHost";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { useShortcuts } from "@/hooks/use-shortcuts";
import {
  browserDevtools,
  browserReload,
  onMenuAction,
  restartDaemon,
  type MenuAction,
} from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { terminalManager } from "@/lib/terminal-manager";
import { useKanban } from "@/state/kanban-context";
import { LeftSidebarProvider } from "@/state/left-sidebar-context";
import { RightSidebarProvider } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";

type Workspace = ReturnType<typeof useWorkspace>;

function preventNativeContextMenu(event: MouseEvent): void {
  // Bubble-phase fallback: Radix context-menu triggers open first, then this blocks
  // the WebView debug/native menu from appearing behind or instead of them.
  event.preventDefault();
}

/** Global keyboard shortcuts wired to workspace actions. */
function useWorkspaceShortcuts(
  workspace: Workspace,
  requestClose: (tab: Tab) => void,
  onOpenCommandPalette: () => void,
  onOpenCommandMode: () => void,
) {
  const activeBrowserTabId =
    workspace.activeTab?.kind === "browser" ? workspace.activeTab.id : null;
  useShortcuts({
    projectId: workspace.activeProject?.id ?? null,
    projectCount: workspace.projects.length,
    onProject: (index) => void workspace.selectProject(workspace.projects[index]?.id ?? null),
    onNextTab: () => workspace.cycleTab(1),
    onPreviousTab: () => workspace.cycleTab(-1),
    onCloseTopTab: () => {
      if (workspace.activeTab) requestClose(workspace.activeTab);
    },
    onNewTerminalTab: () => void workspace.createTerminalTab(),
    onNewBrowserTab: () => void workspace.createBrowserTab(),
    onClearTerminal: () => {
      if (workspace.activeTabId) terminalManager.clear(workspace.activeTabId);
    },
    // Browser-only: no-op (and harmless preventDefault upstream) on terminal tabs.
    onBrowserReload: () => {
      if (activeBrowserTabId) void browserReload(activeBrowserTabId);
    },
    onBrowserDevtools: () => {
      if (activeBrowserTabId) void browserDevtools(activeBrowserTabId);
    },
    onBrowserCopyUrl: () => {
      if (workspace.activeTab?.kind === "browser" && workspace.activeTab.url) {
        void navigator.clipboard.writeText(workspace.activeTab.url);
      }
    },
    onSplitHorizontal: () => {
      if (workspace.activeTabId) workspace.splitActivePane(workspace.activeTabId, "horizontal");
    },
    onSplitVertical: () => {
      if (workspace.activeTabId) workspace.splitActivePane(workspace.activeTabId, "vertical");
    },
    onDeleteSelectedFile: () => {
      // Bridge to the right-sidebar Files tree, which owns the selected-file state.
      window.dispatchEvent(new Event("pragma:request-delete-file"));
    },
    onScrollTerminalBottom: () => {
      if (workspace.activeTabId) terminalManager.scrollToBottom(workspace.activeTabId);
    },
    onOpenCommandPalette,
    onOpenCommandMode,
  });
}

/** Routes native menu shortcuts through the same tab lifecycle as UI controls. */
function useNativeMenuActions(
  workspace: Workspace,
  requestClose: (tab: Tab) => void,
  onOpenCommandPalette: () => void,
  onOpenCommandMode: () => void,
) {
  const shell = useKanban();
  const handleMenuAction = useEffectEvent(async (action: MenuAction) => {
    if (action === "settings.open") {
      shell.openSettings();
      return;
    }
    if (action === "tabs.new-terminal") {
      await workspace.createTerminalTab();
      return;
    }
    if (action === "tabs.close-active") {
      if (workspace.activeTab) requestClose(workspace.activeTab);
      return;
    }
    if (action === "workspace.open-command-palette") {
      onOpenCommandPalette();
      return;
    }
    if (action === "workspace.open-command-mode") {
      onOpenCommandMode();
      return;
    }
    if (action === "troubleshooting.open-daemon-logs") {
      await workspace.openDaemonLogTab();
      return;
    }
    const pending = toast.loading("Restarting daemon…");
    try {
      await restartDaemon();
      toast.success("Daemon restarted", { id: pending });
    } catch (cause) {
      toast.error(errorMessage(cause), { id: pending });
    }
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onMenuAction((action) => void handleMenuAction(action))
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);
}

/** The "Opened from the prompt board" banner with a Back to Kanban button. */
function BackToKanbanBar({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-sidebar-border bg-sidebar px-3 py-1.5">
      <span className="text-xs text-muted-foreground">Opened from the prompt board</span>
      <Button size="sm" variant="secondary" onClick={onReturn}>
        <LayoutGrid className="size-3.5" />
        Back to Kanban
      </Button>
    </div>
  );
}

/** Transient workspace error toast. */
function WorkspaceErrorToast({ error }: { error: string | null }) {
  return (
    <AnimatePresence>
      {error ? (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          exit={{ opacity: 0, y: -6 }}
          initial={{ opacity: 0, y: -6 }}
        >
          {error}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Empty state shown when no project is loaded. */
function NoProjectsState() {
  return (
    <div className="bg-canvas text-muted-foreground flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-3">
        <h1 className="text-foreground text-2xl font-semibold">No projects yet</h1>
        <p className="text-muted-foreground text-sm">
          Open an existing git checkout or clone a repository to start juggling terminals across
          worktrees.
        </p>
        <Button onClick={() => window.dispatchEvent(new Event("pragma:create-project"))}>
          Add project
        </Button>
      </div>
    </div>
  );
}

/** Empty state shown when a project is loaded but has no tabs yet. */
function NoTabsState({ workspace }: { workspace: Workspace }) {
  return (
    <div className="bg-canvas text-muted-foreground flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-md space-y-3">
        <h1 className="text-foreground text-2xl font-semibold">Create a terminal tab</h1>
        <p className="text-muted-foreground text-sm">New tabs start in the selected worktree.</p>
        <Button
          disabled={!workspace.selectedWorktree}
          onClick={() => void workspace.createTerminalTab()}
        >
          New terminal
        </Button>
      </div>
    </div>
  );
}

/** The terminal/right-sidebar area: banner, tabs, error toast, and main split or empty state. */
function WorkspaceContent({
  kanban,
  workspace,
}: {
  kanban: ReturnType<typeof useKanban>;
  workspace: Workspace;
}) {
  return (
    <>
      <section className="app-content bg-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {kanban.backToKanbanAvailable ? <BackToKanbanBar onReturn={kanban.returnToKanban} /> : null}
        <TerminalTabs />
        <WorkspaceErrorToast error={workspace.error} />
        {workspace.projects.length === 0 && !workspace.loading ? (
          <NoProjectsState />
        ) : workspace.tabs.length === 0 ? (
          <NoTabsState workspace={workspace} />
        ) : (
          <SplitHost />
        )}
      </section>
      <RightSidebar />
    </>
  );
}

export function WorkspaceShell() {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const requestClose = useConfirmClose();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<"search" | "command">("search");
  const openCommandPalette = (mode: "search" | "command") => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
  };
  useWorkspaceShortcuts(
    workspace,
    requestClose,
    () => openCommandPalette("search"),
    () => openCommandPalette("command"),
  );
  useNativeMenuActions(
    workspace,
    requestClose,
    () => openCommandPalette("search"),
    () => openCommandPalette("command"),
  );

  return (
    <LeftSidebarProvider>
      <RightSidebarProvider>
        <TabDragProvider>
          {/* h-full (not h-svh): WKWebView does not recompute viewport units (svh/vh)
            on live window resize, which froze the whole height chain — and with it
            the terminal's ResizeObserver — at the launch size. A percentage chain
            from html/body/#root (all height:100% in index.css) does recalc on
            resize, so the terminal re-fits. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onContextMenu on <main> blocks the WebView debug menu behind Radix context menus; there is no interactive role that fits a full-shell capture. */}
          <main
            className="bg-background flex h-full overflow-hidden text-foreground"
            onContextMenu={preventNativeContextMenu}
          >
            {/* Settings mode takes the full frame. Kanban and the normal shell
              keep the project sidebar mounted. */}
            {kanban.mode === "settings" ? (
              <SettingsWorkspace />
            ) : (
              <>
                <ProjectSidebar />
                {/* Kanban mode replaces the shell rather than overlaying it: native
                  browser webviews float above HTML, so an overlay would be clipped.
                  The sidebar stays; only the terminal/right-sidebar area is swapped. */}
                {kanban.mode === "kanban" ? (
                  <ProjectKanbanWorkspace />
                ) : (
                  <WorkspaceContent kanban={kanban} workspace={workspace} />
                )}
              </>
            )}
            {/* Always-mounted dialogs (new-session / deep links) so they work in
              both the normal shell and the Kanban board. */}
            <WorkspaceDialogs />
            <CommandPalette
              mode={commandPaletteMode}
              open={commandPaletteOpen}
              onOpenChange={setCommandPaletteOpen}
            />
          </main>
        </TabDragProvider>
      </RightSidebarProvider>
    </LeftSidebarProvider>
  );
}
