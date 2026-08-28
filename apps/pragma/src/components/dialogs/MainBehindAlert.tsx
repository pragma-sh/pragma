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
import { Button } from "@/components/ui/button";

interface MainBehindAlertProps {
  behind: number;
  mainWorktreeId: string | null;
  onCancel: () => void;
  onConfirm: (pullFirst: boolean) => void;
}

/** Offers sync, skip, and cancel choices before branching from stale main. */
export function MainBehindAlert({
  behind,
  mainWorktreeId,
  onCancel,
  onConfirm,
}: MainBehindAlertProps) {
  return (
    <AlertDialog open={mainWorktreeId !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Main is behind remote</AlertDialogTitle>
          <AlertDialogDescription>
            Main has {behind} commit{behind === 1 ? "" : "s"} to sync. Sync before creating this
            worktree?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={() => onConfirm(false)}>
            Create without syncing
          </Button>
          <AlertDialogAction onClick={() => onConfirm(true)}>Sync and create</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
