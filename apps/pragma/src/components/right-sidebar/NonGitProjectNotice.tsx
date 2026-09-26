import { FolderGit2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useInitializeGit } from "@/hooks/use-initialize-git";
import { requestAddProject } from "@/lib/non-git-project";

/**
 * Replaces the Changes and Pull Request panes for a project that is not a git
 * repository, offering the same ways forward as the Add project warning.
 */
export function NonGitProjectNotice({
  projectId,
  feature,
}: {
  projectId: string;
  feature: string;
}) {
  const { initializing, initialize } = useInitializeGit();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <FolderGit2 aria-hidden className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Not a git repository</p>
        <p className="text-xs text-muted-foreground">
          {feature} and worktree features need git. Initialize a repository here, or open another
          project.
        </p>
      </div>
      <div className="flex w-full max-w-56 flex-col gap-2">
        <Button disabled={initializing} size="sm" onClick={() => void initialize(projectId)}>
          {initializing ? "Initializing…" : "Initialize git repository"}
        </Button>
        <Button size="sm" variant="outline" onClick={requestAddProject}>
          Open another project
        </Button>
      </div>
    </div>
  );
}
