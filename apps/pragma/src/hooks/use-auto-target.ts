import { useMemo } from "react";

import type { Project, Worktree } from "@pragma-sh/constants";

import type { AutoSelectTarget } from "@/hooks/use-auto-agent-selection";
import { useWorkspace } from "@/state/workspace-context";

/** The worktree `id` names and the project that owns it, if it is loaded. */
function findWorktree(
  worktrees: Record<string, Worktree[]> | undefined,
  id: string,
): { projectId: string; worktree: Worktree } | null {
  for (const [projectId, list] of Object.entries(worktrees ?? {})) {
    const worktree = list.find((candidate) => candidate.id === id);
    if (worktree) return { projectId, worktree };
  }
  return null;
}

/** Where a launch runs: the requested worktree, else the selected one. */
function resolveLocation(
  workspace: Pick<
    ReturnType<typeof useWorkspace>,
    "worktrees" | "selectedProjectId" | "selectedWorktree"
  >,
  worktreeId: string | null | undefined,
): { projectId: string | null; worktree: Worktree | null } {
  const selected = { projectId: workspace.selectedProjectId, worktree: workspace.selectedWorktree };
  if (!worktreeId || worktreeId === selected.worktree?.id) return selected;
  return findWorktree(workspace.worktrees, worktreeId) ?? selected;
}

function projectName(projects: Project[] | undefined, id: string | null): string | null {
  return projects?.find((project) => project.id === id)?.name ?? null;
}

/**
 * The auto-mode target for a launch: the prompt, plus the project, worktree,
 * and branch it will run in. `worktreeId` defaults to the selected worktree;
 * the project is the one that owns it, whose `.pragma/automode.md` applies.
 */
export function useAutoTarget(prompt: string, worktreeId?: string | null): AutoSelectTarget {
  const { worktrees, selectedProjectId, selectedWorktree, projects } = useWorkspace();
  return useMemo(() => {
    const { projectId, worktree } = resolveLocation(
      { worktrees, selectedProjectId, selectedWorktree },
      worktreeId,
    );
    return {
      prompt,
      projectId,
      project: projectName(projects, projectId),
      worktree: worktree ? (worktree.title ?? worktree.branch) : null,
      branch: worktree?.branch ?? null,
    };
  }, [prompt, worktreeId, worktrees, selectedProjectId, selectedWorktree, projects]);
}
