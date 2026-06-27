import { useEffect, useState } from "react";

import { Trash2 } from "lucide-react";

import type { KanbanPromptCard } from "@pragma/constants";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { worktreesMergedStatus } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";

interface KanbanDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The card being deleted. Drafts are card-only; started cards take their worktree with them. */
  card: KanbanPromptCard | null;
}

/**
 * Confirms deleting a Kanban card. A draft is just dropped; every started card
 * (in progress, review, completed) also deletes its worktree from disk. When the
 * worktree still holds unmerged work, we re-check its merge status on open and
 * warn that those changes will be lost before allowing the destructive confirm.
 */
export function KanbanDeleteDialog({ open, onOpenChange, card }: KanbanDeleteDialogProps) {
  const kanban = useKanban();
  const [unmerged, setUnmerged] = useState<boolean | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const hasWorktree = card !== null && card.status !== "draft" && card.worktreeId !== null;
  const worktreeId = card?.worktreeId ?? null;

  // Re-fetch merge status each time the dialog opens so a long-running session is
  // still flagged. Drafts (no worktree) skip the check entirely.
  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    setDeleteBranch(false);
    if (!hasWorktree || !worktreeId) {
      setUnmerged(null);
      return;
    }
    let cancelled = false;
    setUnmerged(null);
    void (async () => {
      try {
        const status = await worktreesMergedStatus([worktreeId]);
        if (!cancelled) {
          setUnmerged(status[worktreeId] === false);
        }
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, hasWorktree, worktreeId]);

  if (!card) {
    return null;
  }

  async function confirm() {
    if (!card) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await kanban.deleteCard(card, { deleteBranch });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this card?</AlertDialogTitle>
          <AlertDialogDescription>
            {!hasWorktree ? (
              <>This permanently removes the draft. This can't be undone.</>
            ) : unmerged === true ? (
              <>
                <strong>These changes have not been merged.</strong> Deleting this card also removes
                its worktree from disk — the unmerged work will be lost. This can't be undone.
              </>
            ) : (
              <>
                This removes the card and deletes its worktree from disk. Any tabs belonging to it
                are also closed. This can't be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {hasWorktree ? (
          <label className="flex items-center gap-2 text-sm" htmlFor="kanban-delete-branch">
            <Checkbox
              checked={deleteBranch}
              id="kanban-delete-branch"
              onCheckedChange={(value) => setDeleteBranch(value === true)}
            />
            Also delete the local <code className="font-mono text-xs">{card.branchName}</code>{" "}
            branch
          </label>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <Button
            disabled={deleting}
            onClick={() => void confirm()}
            size="default"
            variant="destructive"
          >
            <Trash2 data-icon="inline-start" />
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
