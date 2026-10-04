import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

interface NonGitFolderWarningProps {
  /** Folder name the user picked. */
  folderName: string;
  busy: boolean;
  onInitialize: () => void;
  onChooseAnother: () => void;
  onContinue: () => void;
  onDontShowAgain: () => void;
}

/**
 * Shown by the Add project dialog when the picked folder is not a git
 * repository. Offers the four ways forward: make it a repository, pick another
 * folder, add it as-is, or add it as-is and stop asking.
 */
export function NonGitFolderWarning({
  folderName,
  busy,
  onInitialize,
  onChooseAnother,
  onContinue,
  onDontShowAgain,
}: NonGitFolderWarningProps) {
  return (
    <div className="space-y-4" role="alert">
      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">“{folderName}” is not a git repository</p>
          <p className="text-muted-foreground">
            Did you mean to open another project? Worktree features — new worktrees, changes, and
            pull requests — will not be available until it is a git repository.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={busy} onClick={onInitialize}>
          Initialize git repository
        </Button>
        <Button disabled={busy} variant="outline" onClick={onChooseAnother}>
          Open another project
        </Button>
        <Button disabled={busy} variant="outline" onClick={onContinue}>
          Continue without git
        </Button>
        <Button disabled={busy} variant="ghost" onClick={onDontShowAgain}>
          Don’t show again
        </Button>
      </div>
    </div>
  );
}
