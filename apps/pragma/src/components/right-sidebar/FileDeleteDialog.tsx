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
import { basename } from "@/lib/path";

interface FileDeleteDialogProps {
  /** Paths awaiting confirmation; `null` closes the dialog. */
  paths: string[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms a Files-pane delete on a plain (non-git) project. A git worktree can
 * restore a deleted file, so it deletes straight away; a plain folder cannot,
 * so the user is asked first.
 */
export function FileDeleteDialog({ paths, onCancel, onConfirm }: FileDeleteDialogProps) {
  const [first] = paths ?? [];
  const subject =
    paths?.length === 1 && first !== undefined ? `“${basename(first)}”` : `${paths?.length} items`;
  return (
    <AlertDialog open={paths !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {subject}?</AlertDialogTitle>
          <AlertDialogDescription>
            This project is not a git repository, so a deleted file cannot be restored from Pragma.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
