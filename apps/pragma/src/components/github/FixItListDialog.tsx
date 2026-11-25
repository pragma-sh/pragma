import { useState } from "react";

import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { CommitAndPushToggle } from "@/components/github/CommitAndPushToggle";
import { FixAgentControls } from "@/components/github/FixAgentControls";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAutoSubmit } from "@/hooks/use-auto-agent-selection";
import { useFixLauncher } from "@/hooks/use-fix-launcher";
import { buildListFixPrompt, commentLocation } from "@/lib/fix-it-prompt";
import {
  clearFixItComments,
  type FixItComment,
  removeFixItComment,
  useFixItComments,
} from "@/state/fix-it-store";

/**
 * The "Address fix it list" dialog: the comments the user flagged to fix (each
 * removable), an agent picker, and a collapsible "fix on a new worktree" section.
 * Launching seeds one agent session with a prompt covering every listed comment,
 * then clears the list.
 *
 * Given `presetComments`, it is instead the "Fix all comments" dialog: the list
 * starts as exactly those comments (every unresolved thread), removals stay local
 * to the dialog, and launching leaves the user's fix it list untouched.
 */
export function FixItListDialog({
  prNumber,
  worktreeId,
  open,
  onOpenChange,
  presetComments,
}: {
  prNumber: number;
  worktreeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetComments?: readonly FixItComment[];
}) {
  const isPreset = presetComments !== undefined;
  const { comments, remove, markLaunched } = useDialogComments(prNumber, presetComments);
  const launcher = useFixLauncher(open, worktreeId);
  const [commitAndPush, setCommitAndPush] = useState(false);
  const prompt = comments.length > 0 ? buildListFixPrompt([...comments], { commitAndPush }) : "";

  async function submit() {
    if (comments.length === 0) {
      return;
    }
    const ok = await launcher.launch(prompt);
    if (ok) {
      toast.success(
        `Launched agent to fix ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
      );
      markLaunched();
      onOpenChange(false);
    }
  }
  const auto = useAutoSubmit(submit);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isPreset ? "Fix all comments" : "Address fix it list"}</DialogTitle>
          <DialogDescription>
            {isPreset
              ? "Launch an agent to verify and fix every unresolved comment on this pull request."
              : "Launch an agent to verify and fix every comment you flagged on this pull request."}
          </DialogDescription>
        </DialogHeader>

        <FixItList comments={comments} isPreset={isPreset} onRemove={remove} />

        <FixAgentControls launcher={launcher} prompt={prompt} autoRegistry={auto.registry} />

        <CommitAndPushToggle checked={commitAndPush} onCheckedChange={setCommitAndPush} />

        {launcher.error ? <p className="text-xs text-destructive">{launcher.error}</p> : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!launcher.canLaunch || comments.length === 0 || auto.resolving}
            onClick={() => void auto.submit()}
            size="sm"
          >
            {launcher.busy ? <Loader2 className="animate-spin" /> : null}
            {launcher.newWorktree.enabled ? "Create worktree & fix all" : "Fix all"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The comments a dialog covers: the user's live fix it list, or a local copy of
 * `presetComments` whose removals and launch never touch that list.
 */
function useDialogComments(prNumber: number, presetComments?: readonly FixItComment[]) {
  const flagged = useFixItComments(prNumber);
  // A snapshot taken on open, so a background refresh never reshuffles the list.
  const [preset, setPreset] = useState<readonly FixItComment[]>(() => presetComments ?? []);
  if (presetComments === undefined) {
    return {
      comments: flagged,
      remove: (threadId: string) => removeFixItComment(prNumber, threadId),
      markLaunched: () => clearFixItComments(prNumber),
    };
  }
  return {
    comments: preset,
    remove: (threadId: string) =>
      setPreset((list) => list.filter((entry) => entry.threadId !== threadId)),
    markLaunched: () => {},
  };
}

/** The scrollable comment list, or a note explaining why it is empty. */
function FixItList({
  comments,
  isPreset,
  onRemove,
}: {
  comments: readonly FixItComment[];
  isPreset: boolean;
  onRemove: (threadId: string) => void;
}) {
  if (comments.length === 0) {
    return (
      <p className="rounded-md border border-border bg-canvas px-3 py-6 text-center text-xs text-muted-foreground">
        {isPreset
          ? "No unresolved comments to fix."
          : "No comments flagged yet. Use “Add to fix it list” on a review comment."}
      </p>
    );
  }
  return (
    <ScrollArea className="max-h-48 rounded-md border border-border bg-canvas">
      <ul className="divide-y divide-border">
        {comments.map((comment) => (
          <FixItRow
            comment={comment}
            key={comment.threadId}
            onRemove={() => onRemove(comment.threadId)}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

/** One comment in the list, with a remove button. */
function FixItRow({ comment, onRemove }: { comment: FixItComment; onRemove: () => void }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] text-muted-foreground">{commentLocation(comment)}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{comment.body}</p>
      </div>
      <IconButton
        aria-label="Remove from list"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        label="Remove"
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <X />
      </IconButton>
    </li>
  );
}
