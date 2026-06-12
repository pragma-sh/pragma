import { Plus } from "lucide-react";
import { useWorkspace } from "@/state/workspace-context";
import { buildTree } from "@/lib/worktree-tree";
import { WorktreeTree } from "./WorktreeTree";
import { ProjectSwitcher } from "./ProjectSwitcher";

interface Props {
  onNewWorktree: (parentId: string) => void;
  onNewProject: () => void;
}

export function ProjectSidebar({ onNewWorktree, onNewProject }: Props) {
  const { state, dispatch } = useWorkspace();
  // The header row IS the main worktree, so the tree shows its descendants
  // (promoting the main node's children to the top level) plus any stray roots.
  const tree = buildTree(state.worktrees).flatMap((node) =>
    node.worktree.isMain ? node.children : [node],
  );
  const activeProject = state.projects.find((p) => p.id === state.activeProjectId);
  const mainWorktree = state.worktrees.find((w) => w.isMain);
  const isSelected = mainWorktree != null && state.selectedWorktreeId === mainWorktree.id;
  const branchLabel = mainWorktree?.branch ?? "main";

  return (
    <div className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
      <div className="flex items-center gap-1 px-2 pt-2">
        <button
          type="button"
          onClick={() => {
            if (mainWorktree) {
              dispatch({ type: "SELECT_WORKTREE", worktreeId: mainWorktree.id });
            }
          }}
          className={`flex flex-1 items-center rounded-md px-2 py-1.5 text-left font-semibold text-sm ${isSelected ? "bg-accent" : "hover:bg-accent/50"}`}
        >
          <span className="truncate">{activeProject?.name ?? "No project"}</span>
          {mainWorktree && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{branchLabel}</span>
          )}
        </button>
        <button
          type="button"
          title="New worktree"
          onClick={() => {
            const parentId = mainWorktree?.id;
            if (parentId) onNewWorktree(parentId);
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:bg-accent"
        >
          <Plus className="size-3" />
        </button>
      </div>

      <WorktreeTree nodes={tree} onCreateWorktree={onNewWorktree} />

      <ProjectSwitcher onNewProject={onNewProject} />
    </div>
  );
}
