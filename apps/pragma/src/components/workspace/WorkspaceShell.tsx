import { AnimatePresence, motion } from "motion/react";
import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";
import { LayoutGrid, X } from "lucide-react";
import { toast } from "sonner";

import { useConfirmClose } from "@/components/editor/confirm-close";
import type { Tab } from "@pragma/constants";
import { ProjectKanbanWorkspace } from "@/components/kanban/ProjectKanbanWorkspace";
import { SettingsWorkspace } from "@/components/settings/SettingsWorkspace";
import { RightSidebar } from "@/components/right-sidebar/RightSidebar";
import { IconTooltip } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { ProjectSidebar } from "@/components/sidebar/ProjectSidebar";
import { TabDragProvider } from "@/components/tabs/tab-drag-context";
import { TerminalTabs } from "@/components/tabs/TerminalTabs";
import { SplitHost } from "@/components/workspace/SplitHost";
import { WelcomeScreen } from "@/components/workspace/WelcomeScreen";
import { WorkspaceDialogs } from "@/components/workspace/WorkspaceDialogs";
import { WorktreeCreationScreen } from "@/components/workspace/WorktreeCreationScreen";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { useShortcuts } from "@/hooks/use-shortcuts";
import {
  ShortcutHintsProvider,
  useWorktreeShortcutOrder,
  type ShortcutHints,
} from "@/lib/shortcut-hints";
import { browserDevtools, browserReload, onMenuAction, type MenuAction } from "@/lib/tauri";
import { errorMessage } from "@/lib/errors";
import { terminalManager } from "@/lib/terminal-manager";
import { reloadWebview, restartServer } from "@/lib/troubleshooting";
import { useKanban } from "@/state/kanban-context";
import { LeftSidebarProvider } from "@/state/left-sidebar-context";
import { useOnboarding } from "@/state/onboarding-context";
import { RightSidebarProvider } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import { FanoutComparison } from "@/components/fanout/FanoutComparison";
import { useFanouts } from "@/state/fanouts-context";
import { useWorktreeCreation } from "@/state/worktree-creation-context";

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
): ShortcutHints {
  const activeBrowserTabId =
    workspace.activeTab?.kind === "browser" ? workspace.activeTab.id : null;
  const worktreeOrder = useWorktreeShortcutOrder();
  return useShortcuts({
    projectId: workspace.activeProject?.id ?? null,
    projectCount: workspace.projects.length,
    onProject: (index) => void workspace.selectProject(workspace.projects[index]?.id ?? null),
    worktreeCount: worktreeOrder.length,
    onWorktree: (index) => workspace.selectWorktree(worktreeOrder[index] ?? null),
    tabCount: workspace.tabs.length,
    onTab: (index) => {
      const tab = workspace.tabs[index];
      if (tab) workspace.setActiveTab(tab.id);
    },
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
async function restartDaemonWithToast(workspace: Workspace): Promise<void> {
  const pending = toast.loading("Restarting daemon…");
  try {
    await restartServer(workspace);
    toast.success("Daemon restarted", { id: pending });
  } catch (cause) {
    toast.error(errorMessage(cause), { id: pending });
  }
}

function useNativeMenuActions(
  workspace: Workspace,
  requestClose: (tab: Tab) => void,
  onOpenCommandPalette: () => void,
  onOpenCommandMode: () => void,
) {
  const shell = useKanban();
  const onboarding = useOnboarding();
  const handleMenuAction = useEffectEvent(async (action: MenuAction) => {
    const actions = {
      "settings.open": shell.openSettings,
      "onboarding.start-tour": async () => {
        await onboarding.restartTour();
        // The tour anchors only exist once a project is open, so say why nothing
        // happened rather than arming a tour the user never sees.
        if (workspace.projects.length === 0) toast.info("Open a project to start the tour");
      },
      "tabs.new-terminal": async () => {
        await workspace.createTerminalTab();
      },
      "tabs.close-active": () => {
        if (workspace.activeTab) requestClose(workspace.activeTab);
      },
      "workspace.open-command-palette": onOpenCommandPalette,
      "workspace.open-command-mode": onOpenCommandMode,
      "troubleshooting.open-daemon-logs": () => workspace.openDaemonLogTab(),
      "troubleshooting.reload": reloadWebview,
      "troubleshooting.restart-daemon": () => restartDaemonWithToast(workspace),
    } satisfies Record<MenuAction, () => void | Promise<void>>;
    await actions[action]();
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

/** The "Opened from the agent board" banner with a return button. */
function BackToAgentBoardBar({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-sidebar-border bg-sidebar px-3 py-1.5">
      <span className="text-xs text-muted-foreground">Opened from the agent board</span>
      <Button size="sm" variant="secondary" onClick={onReturn}>
        <LayoutGrid className="size-3.5" />
        Back to agent board
      </Button>
    </div>
  );
}

/** Transient workspace error toast, dismissible with its close button. */
function WorkspaceErrorToast({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <AnimatePresence>
      {error ? (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="text-destructive border-destructive/30 bg-destructive/10 mx-4 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
          exit={{ opacity: 0, y: -6 }}
          initial={{ opacity: 0, y: -6 }}
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <IconTooltip label="Dismiss">
            <button
              aria-label="Dismiss error"
              className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 -mr-1 rounded p-0.5 transition-colors"
              onClick={onDismiss}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </IconTooltip>
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
        <h1 className="text-foreground text-2xl font-semibold">What will you build with Pragma?</h1>
        <p className="text-muted-foreground text-sm">Open a project to get started.</p>
        <Button onClick={() => window.dispatchEvent(new Event("pragma:create-project"))}>
          Add project
        </Button>
      </div>
    </div>
  );
}

/** The terminal/right-sidebar area: tabs, board-return strip, errors, and main content. */
function WorkspaceContent({
  kanban,
  workspace,
}: {
  kanban: ReturnType<typeof useKanban>;
  workspace: Workspace;
}) {
  const fanouts = useFanouts();
  const comparing = fanouts.fanouts.find((fanout) => fanout.id === fanouts.comparingFanoutId);
  // Comparison replaces the centre workspace and the right sidebar rather than
  // overlaying them: native browser webviews float above HTML, so an overlay
  // would be clipped by whatever is behind it.
  if (comparing) {
    return <FanoutComparison fanout={comparing} />;
  }
  return (
    <>
      <section className="app-content bg-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TerminalTabs />
        {kanban.backToKanbanAvailable ? (
          <BackToAgentBoardBar onReturn={kanban.returnToKanban} />
        ) : null}
        <WorkspaceErrorToast error={workspace.error} onDismiss={workspace.clearError} />
        {workspace.projects.length === 0 && !workspace.loading ? (
          <NoProjectsState />
        ) : workspace.tabs.length === 0 ? (
          <WelcomeScreen />
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
  const { creation } = useWorktreeCreation();
  const requestClose = useConfirmClose();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<"search" | "command">("search");
  const openCommandPalette = (mode: "search" | "command") => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
  };
  const shortcutHints = useWorkspaceShortcuts(
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
    <ShortcutHintsProvider hints={shortcutHints}>
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
              {/* Settings mode takes the full frame. Agent board and normal shell
              keep the project sidebar mounted. */}
              {kanban.mode === "settings" ? (
                <SettingsWorkspace />
              ) : (
                <>
                  <ProjectSidebar />
                  {/* Agent board mode replaces the shell rather than overlaying it: native
                  browser webviews float above HTML, so an overlay would be clipped.
                  The sidebar stays; only the terminal/right-sidebar area is swapped. */}
                  {/* Creating a worktree takes over the same area for the same
                  reason: it is a full-frame loading screen, not an overlay. */}
                  {creation ? (
                    <WorktreeCreationScreen />
                  ) : kanban.mode === "kanban" ? (
                    <ProjectKanbanWorkspace />
                  ) : (
                    <WorkspaceContent kanban={kanban} workspace={workspace} />
                  )}
                </>
              )}
              {/* Always-mounted dialogs (new-session / deep links) so they work in
              both the normal shell and the agent board. */}
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
    </ShortcutHintsProvider>
  );
}
