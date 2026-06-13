import { AnimatePresence, motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { ProjectSidebar } from "@/components/sidebar/ProjectSidebar";
import { TerminalHost } from "@/components/terminal/TerminalHost";
import { TerminalTabs } from "@/components/tabs/TerminalTabs";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { terminalManager } from "@/lib/terminal-manager";
import { useWorkspace } from "@/state/workspace-context";

export function WorkspaceShell() {
  const workspace = useWorkspace();

  useShortcuts({
    projectCount: workspace.projects.length,
    onProject: (index) => void workspace.selectProject(workspace.projects[index]?.id ?? null),
    onNextTab: () => workspace.cycleTab(1),
    onPreviousTab: () => workspace.cycleTab(-1),
    onCloseTopTab: () => {
      if (workspace.activeTabId) {
        void workspace.closeTerminalTab(workspace.activeTabId);
      }
    },
    onNewTerminalTab: () => void workspace.createTerminalTab(),
    onClearTerminal: () => {
      if (workspace.activeTabId) {
        terminalManager.clear(workspace.activeTabId);
      }
    },
  });

  return (
    <main className="bg-background flex h-svh overflow-hidden text-foreground">
      <ProjectSidebar />
      <section className="flex min-w-0 flex-1 flex-col bg-[#0b0d10]">
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
          <TerminalHost />
        )}
      </section>
    </main>
  );
}
