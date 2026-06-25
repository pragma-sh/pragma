import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { FixAgentControls } from "@/components/github/FixAgentControls";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
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
 */
export function FixItListDialog({
  prNumber,
  worktreeId,
  open,
  onOpenChange,
}: {
  prNumber: number;
  worktreeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const comments = useFixItComments(prNumber);
  const launcher = useFixLauncher(open, worktreeId);

  async function submit() {
    if (comments.length === 0) {
      return;
    }
    const ok = await launcher.launch(buildListFixPrompt([...comments]));
    if (ok) {
      toast.success(
        `Launched agent to fix ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
      );
      clearFixItComments(prNumber);
      onOpenChange(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Address fix it list</DialogTitle>
          <DialogDescription>
            Launch an agent to verify and fix every comment you flagged on this pull request.
          </DialogDescription>
        </DialogHeader>

        {comments.length === 0 ? (
          <p className="rounded-md border border-white/10 bg-black/20 px-3 py-6 text-center text-xs text-slate-500">
            No comments flagged yet. Use “Add to fix it list” on a review comment.
          </p>
        ) : (
          <ScrollArea className="max-h-48 rounded-md border border-white/10 bg-black/20">
            <ul className="divide-y divide-white/5">
              {comments.map((comment) => (
                <FixItRow comment={comment} key={comment.threadId} prNumber={prNumber} />
              ))}
            </ul>
          </ScrollArea>
        )}

        <FixAgentControls launcher={launcher} />

        {launcher.error ? <p className="text-xs text-destructive">{launcher.error}</p> : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!launcher.canLaunch || comments.length === 0}
            onClick={() => void submit()}
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

/** One flagged comment in the list, with a remove button. */
function FixItRow({ comment, prNumber }: { comment: FixItComment; prNumber: number }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] text-slate-500">{commentLocation(comment)}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-slate-300">{comment.body}</p>
      </div>
      <Button
        aria-label="Remove from fix it list"
        className="shrink-0 text-slate-500 hover:text-slate-200"
        onClick={() => removeFixItComment(prNumber, comment.threadId)}
        size="icon-sm"
        title="Remove from fix it list"
        variant="ghost"
      >
        <X />
      </Button>
    </li>
  );
}
