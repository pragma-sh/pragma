import { useCallback, useEffect, useState } from "react";
import {
  listProjects,
  listWorktrees,
  listTabs,
  createTab,
  deleteTab,
  getProjectIcon,
  getProjectsDirectory,
  ptyKill,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";
import { useWorkspaceShortcuts } from "@/hooks/use-shortcuts";
import { ProjectSidebar } from "@/components/sidebar/ProjectSidebar";
import { TerminalTabs } from "@/components/tabs/TerminalTabs";
import { TerminalHost } from "@/components/terminal/TerminalHost";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { TooltipProvider } from "@/components/ui/tooltip";

export function WorkspaceShell() {
  const { state, dispatch } = useWorkspace();
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [newWorktreeParentId, setNewWorktreeParentId] = useState<string | null>(null);

  useEffect(() => {
    void listProjects().then((projects) => {
      dispatch({ type: "SET_PROJECTS", projects });
      return undefined;
    });
    void getProjectsDirectory().then((dir) => {
      if (dir) dispatch({ type: "SET_PROJECTS_DIRECTORY", dir });
      return undefined;
    });
  }, [dispatch]);

  useEffect(() => {
    if (!state.activeProjectId) return;
    const projectId = state.activeProjectId;
    void listWorktrees(projectId).then((worktrees) => {
      dispatch({ type: "SET_WORKTREES", worktrees });
      return undefined;
    });
    void listTabs(projectId).then((tabs) => {
      dispatch({ type: "SET_TABS", tabs });
      return undefined;
    });
  }, [state.activeProjectId, dispatch]);

  useEffect(() => {
    for (const project of state.projects) {
      if (!state.iconCache.has(project.id)) {
        void getProjectIcon(project.id).then((icon) => {
          if (icon) {
            dispatch({
              type: "SET_ICON",
              projectId: project.id,
              data: `data:${icon.mime};base64,${icon.dataBase64}`,
            });
          }
          return undefined;
        });
      }
    }
  }, [state.projects, state.iconCache, dispatch]);

  const handleNewWorktree = useCallback((parentId: string) => {
    setNewWorktreeParentId(parentId);
    setShowNewWorktree(true);
  }, []);

  const handleCreateTab = useCallback(() => {
    if (!state.activeProjectId || !state.selectedWorktreeId) return;
    const tabId = crypto.randomUUID();
    const orderIndex = state.tabs.length;
    const projectId = state.activeProjectId;
    const worktreeId = state.selectedWorktreeId;
    dispatch({
      type: "ADD_TAB",
      tab: {
        id: tabId,
        projectId,
        worktreeId,
        title: null,
        orderIndex,
        createdAt: new Date().toISOString(),
      },
    });
    // Persist so the tab reattaches to its daemon session after a restart.
    void createTab(tabId, projectId, worktreeId, orderIndex);
  }, [state.activeProjectId, state.selectedWorktreeId, state.tabs.length, dispatch]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      void ptyKill(tabId);
      void deleteTab(tabId);
      dispatch({ type: "REMOVE_TAB", tabId });
    },
    [dispatch],
  );

  useWorkspaceShortcuts({
    onProjectDigit: (index) => {
      const project = state.projects[index];
      if (project) {
        dispatch({ type: "SET_ACTIVE_PROJECT", projectId: project.id });
      }
    },
    onNextTab: () => {
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const next = (idx + 1) % state.tabs.length;
      const tab = state.tabs[next];
      if (tab) dispatch({ type: "SET_ACTIVE_TAB", tabId: tab.id });
    },
    onPrevTab: () => {
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const prev = (idx - 1 + state.tabs.length) % state.tabs.length;
      const tab = state.tabs[prev];
      if (tab) dispatch({ type: "SET_ACTIVE_TAB", tabId: tab.id });
    },
  });

  return (
    <TooltipProvider>
      <div className="flex h-svh overflow-hidden bg-background text-sm">
        <ProjectSidebar
          onNewWorktree={handleNewWorktree}
          onNewProject={() => setShowNewProject(true)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TerminalTabs onCreateTab={handleCreateTab} onCloseTab={handleCloseTab} />
          <TerminalHost
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            worktrees={state.worktrees}
            attachableTabIds={state.attachableTabIds}
          />
        </div>
      </div>

      <CreateProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
      <CreateWorktreeDialog
        open={showNewWorktree}
        onOpenChange={setShowNewWorktree}
        parentWorktreeId={newWorktreeParentId}
      />
    </TooltipProvider>
  );
}
