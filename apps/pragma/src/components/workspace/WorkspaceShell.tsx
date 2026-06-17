import { AnimatePresence, motion } from "motion/react";

import { useConfirmClose } from "@/components/editor/confirm-close";
import { RightSidebar } from "@/components/right-sidebar/RightSidebar";
import { Button } from "@/components/ui/button";
import { ProjectSidebar } from "@/components/sidebar/ProjectSidebar";
import { TabDragProvider } from "@/components/tabs/tab-drag-context";
import { TerminalTabs } from "@/components/tabs/TerminalTabs";
import { SplitHost } from "@/components/workspace/SplitHost";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { browserDevtools, browserReload } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { RightSidebarProvider } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";

export function WorkspaceShell() {
  const workspace = useWorkspace();
  const requestClose = useConfirmClose();
  const activeBrowserTabId =
    workspace.activeTab?.kind === "browser" ? workspace.activeTab.id : null;

  useShortcuts({
    projectCount: workspace.projects.length,
    onProject: (index) => void workspace.selectProject(workspace.projects[index]?.id ?? null),
    onNextTab: () => workspace.cycleTab(1),
    onPreviousTab: () => workspace.cycleTab(-1),
    onCloseTopTab: () => {
      if (workspace.activeTab) {
        requestClose(workspace.activeTab);
      }
    },
    onNewTerminalTab: () => void workspace.createTerminalTab(),
    onNewBrowserTab: () => void workspace.createBrowserTab(),
    onClearTerminal: () => {
      if (workspace.activeTabId) {
        terminalManager.clear(workspace.activeTabId);
      }
    },
    // Browser-only: no-op (and harmless preventDefault upstream) on terminal tabs.
    onBrowserReload: () => {
      if (activeBrowserTabId) {
        void browserReload(activeBrowserTabId);
      }
    },
    onBrowserDevtools: () => {
      if (activeBrowserTabId) {
        void browserDevtools(activeBrowserTabId);
      }
    },
    onBrowserCopyUrl: () => {
      if (workspace.activeTab?.kind === "browser" && workspace.activeTab.url) {
        void navigator.clipboard.writeText(workspace.activeTab.url);
      }
    },
    onSplitHorizontal: () => {
      if (workspace.activeTabId) {
        workspace.splitActivePane(workspace.activeTabId, "horizontal");
      }
    },
    onSplitVertical: () => {
      if (workspace.activeTabId) {
        workspace.splitActivePane(workspace.activeTabId, "vertical");
      }
    },
    onDeleteSelectedFile: () => {
      // Bridge to the right-sidebar Files tree, which owns the selected-file
      // state. The tree listens for this event and opens its delete confirm.
      window.dispatchEvent(new Event("pragma:request-delete-file"));
    },
    onScrollTerminalBottom: () => {
      if (workspace.activeTabId) {
        terminalManager.scrollToBottom(workspace.activeTabId);
      }
    },
  });

  return (
    <RightSidebarProvider>
      <TabDragProvider>
        {/* h-full (not h-svh): WKWebView does not recompute viewport units (svh/vh)
            on live window resize, which froze the whole height chain — and with it
            the terminal's ResizeObserver — at the launch size. A percentage chain
            from html/body/#root (all height:100% in index.css) does recalc on
            resize, so the terminal re-fits. */}
        <main className="bg-background flex h-full overflow-hidden text-foreground">
          <ProjectSidebar />
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#0b0d10]">
            <TerminalTabs />
            <AnimatePresence>
              {workspace.error ? (
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  exit={{ opacity: 0, y: -6 }}
                  initial={{ opacity: 0, y: -6 }}
                >
                  {workspace.error}
                </motion.div>
              ) : null}
            </AnimatePresence>
            {workspace.projects.length === 0 && !workspace.loading ? (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-300">
                <div className="max-w-md space-y-3">
                  <h1 className="text-2xl font-semibold text-white">No projects yet</h1>
                  <p className="text-sm text-slate-400">
                    Open an existing git checkout or clone a repository to start juggling terminals
                    across worktrees.
                  </p>
                  <Button onClick={() => window.dispatchEvent(new Event("pragma:create-project"))}>
                    Add project
                  </Button>
                </div>
              </div>
            ) : workspace.tabs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-300">
                <div className="max-w-md space-y-3">
                  <h1 className="text-2xl font-semibold text-white">Create a terminal tab</h1>
                  <p className="text-sm text-slate-400">New tabs start in the selected worktree.</p>
                  <Button
                    disabled={!workspace.selectedWorktree}
                    onClick={() => void workspace.createTerminalTab()}
                  >
                    New terminal
                  </Button>
                </div>
              </div>
            ) : (
              <SplitHost />
            )}
          </section>
          <RightSidebar />
        </main>
      </TabDragProvider>
    </RightSidebarProvider>
  );
}
