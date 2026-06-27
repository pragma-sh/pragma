import { useEffect, useState } from "react";

import { GitMerge, GitPullRequestCreate, Loader2, SquareArrowOutUpRight } from "lucide-react";

import type { KanbanCompletedAction, KanbanPromptCard } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { useKanban } from "@/state/kanban-context";

interface KanbanCompletionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Review-needed card being completed. */
  card: KanbanPromptCard | null;
}

/**
 * Picks how a reviewNeeded card is completed when it's dragged into the Completed
 * column (the per-card buttons trigger merge/PR directly). Commit & merge and
 * commit & open PR hand off to {@link useKanban}'s `completeCard`, which moves the
 * card immediately and runs the work in the background; "go to worktree" finishes
 * the card and opens its session.
 */
export function KanbanCompletionDialog({
  open: isOpen,
  onOpenChange,
  card,
}: KanbanCompletionDialogProps) {
  const kanban = useKanban();
  const [manualRunning, setManualRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeToClose(isOpen && !manualRunning, () => onOpenChange(false));

  useEffect(() => {
    if (isOpen) {
      setManualRunning(false);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen || !card) {
    return null;
  }

  // Commit/merge and commit/PR run in the background; close the dialog right away
  // so the card's own loading badge tracks progress.
  function complete(action: Extract<KanbanCompletedAction, "commitMerge" | "commitPr">) {
    if (!card) {
      return;
    }
    void kanban.completeCard(card, action);
    onOpenChange(false);
  }

  async function goToWorktree() {
    if (!card) {
      return;
    }
    setManualRunning(true);
    setError(null);
    try {
      const saved = await kanban.runCompletion(card, "manual");
      kanban.openCardWorktree(saved);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setManualRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Complete card</h2>
          <p className="truncate text-sm text-muted-foreground">{card.branchName}</p>
        </div>

        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

        <div className="mt-5 space-y-2">
          <CompletionOption
            icon={<GitMerge className="size-4" />}
            title="Commit all and merge"
            description="Stage everything, generate a commit message, commit, and merge into the parent branch — runs in the background."
            running={false}
            disabled={manualRunning}
            onClick={() => complete("commitMerge")}
          />
          <CompletionOption
            icon={<GitPullRequestCreate className="size-4" />}
            title="Commit all and open PR"
            description="Commit everything, push the branch, and open a pull request — runs in the background."
            running={false}
            disabled={manualRunning}
            onClick={() => complete("commitPr")}
          />
          <CompletionOption
            icon={<SquareArrowOutUpRight className="size-4" />}
            title="Go to worktree"
            description="Mark complete and open the worktree in the normal workspace."
            running={manualRunning}
            disabled={manualRunning}
            onClick={() => void goToWorktree()}
          />
          <div className="flex justify-end pt-2">
            <Button variant="ghost" disabled={manualRunning} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompletionOption({
  icon,
  title,
  description,
  running,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-0.5 text-muted-foreground">
        {running ? <Loader2 className="size-4 animate-spin" /> : icon}
      </span>
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
