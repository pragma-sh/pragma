import { useCallback, useEffect, useState } from "react";

import { Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useWorkspace } from "@/state/workspace-context";

interface WorktreeDeleteDialogProps {
  worktreeId: string;
  worktreeLabel: string;
  /** Optional hover-revealed trigger button. Omit when the dialog is opened
   *  imperatively from a context menu or keyboard shortcut. */
  trigger?: React.ReactNode;
  /** Controlled open state. Required when `trigger` is omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Confirmation dialog for deleting a worktree from disk and from Pragma.
 *
 * The destructive action is gated on:
 *  1. The user acknowledging any uncommitted changes (re-fetches on each open
 *     so a long-running session is still flagged), and
 *  2. Optionally, the user checking the "Also delete the branch" box.
 *
 * We use a plain `Button` (not `AlertDialogAction`) for the confirm action so
 * the click handler keeps full control: it fires the optimistic delete and
 * closes the modal itself, rather than relying on `AlertDialogAction`'s
 * auto-close.
 */
export function WorktreeDeleteDialog({
  worktreeId,
  worktreeLabel,
  trigger,
  open: openProp,
  onOpenChange,
}: WorktreeDeleteDialogProps) {
  const workspace = useWorkspace();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      if (!isControlled) {
        setInternalOpen(value);
      }
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange],
  );
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [dirty, setDirty] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    let cancelled = false;
    setDirty(null);
    void (async () => {
      try {
        const status = await workspace.getWorktreeStatus(worktreeId);
        if (cancelled) {
          return;
        }
        setDirty(status.dirty);
      } catch (cause: unknown) {
        if (cancelled) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, worktreeId, workspace]);

  function confirm() {
    // Optimistic: the context drops the worktree from local state (and thus
    // the sidebar) synchronously — before the first await inside
    // `deleteWorktree` — so we close the modal immediately. The backend delete
    // continues in the background and surfaces a toast on failure; there's no
    // inline error to show anymore (the dialog is already gone).
    void workspace.deleteWorktree(worktreeId, {
      deleteBranch,
      force: dirty === true,
    });
    setOpen(false);
  }

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {worktreeLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            {dirty === true ? (
              <>
                <strong>Uncommitted changes detected.</strong> Uncommitted, staged, and untracked
                files in this worktree will be lost.
              </>
            ) : (
              <>
                This removes the worktree from disk and from Pragma. Any tabs belonging to it are
                also closed.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2" htmlFor="confirm-delete-branch">
            <Checkbox
              checked={deleteBranch}
              id="confirm-delete-branch"
              onCheckedChange={(value) => setDeleteBranch(value === true)}
            />
            Also delete the <code className="font-mono text-xs">{worktreeLabel}</code> branch
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button onClick={() => confirm()} size="default" variant="destructive">
            <Trash2 data-icon="inline-start" />
            Delete anyway
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
