import { projectIsGit } from "@/lib/non-git-project";
import { useWorkspace } from "@/state/workspace-context";

/** The selected project's id when it is not a git repository, otherwise `null`. */
export function usePlainProjectId(): string | null {
  const { activeProject } = useWorkspace();
  return activeProject && !projectIsGit(activeProject) ? activeProject.id : null;
}
