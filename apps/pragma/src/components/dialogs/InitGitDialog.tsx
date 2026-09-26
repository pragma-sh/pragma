import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useInitializeGit } from "@/hooks/use-initialize-git";

interface InitGitDialogProps {
  /** The plain project to initialize; `null` closes the dialog. */
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Runs after the repository exists, e.g. to continue into worktree creation. */
  onInitialized?: () => void;
}

/**
 * Asked when the user reaches for a worktree feature on a project that is not a
 * git repository: worktrees need one, so offer to create it.
 */
export function InitGitDialog({ projectId, onOpenChange, onInitialized }: InitGitDialogProps) {
  const { initializing, initialize } = useInitializeGit();
  return (
    <AlertDialog open={projectId !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Initialize a git repository?</AlertDialogTitle>
          <AlertDialogDescription>
            This project is not a git repository, so it cannot have worktrees. Pragma can run{" "}
            <code>git init</code> in the project folder and create an empty first commit. Your
            files, tabs, and agent sessions stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={initializing}>Not now</AlertDialogCancel>
          <AlertDialogAction
            disabled={initializing || projectId === null}
            onClick={async (event) => {
              // Keep the dialog open until git answers.
              event.preventDefault();
              if (projectId === null || !(await initialize(projectId))) return;
              onOpenChange(false);
              onInitialized?.();
            }}
          >
            {initializing ? "Initializing…" : "Initialize git repository"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
