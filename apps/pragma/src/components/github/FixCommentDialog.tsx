import { Loader2 } from "lucide-react";
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
import { useFixLauncher } from "@/hooks/use-fix-launcher";
import { buildSingleFixPrompt, commentLocation } from "@/lib/fix-it-prompt";
import type { FixItComment } from "@/state/fix-it-store";

/**
 * Launches an agent to verify-and-fix a single review comment. Quotes the comment
 * at the top, lets the user pick the agent, and optionally branch a new worktree
 * to fix on (collapsed by default). `comment` being non-null drives the open state.
 */
export function FixCommentDialog({
  comment,
  worktreeId,
  open,
  onOpenChange,
}: {
  comment: FixItComment | null;
  worktreeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const launcher = useFixLauncher(open, worktreeId);

  async function submit() {
    if (!comment) {
      return;
    }
    const ok = await launcher.launch(buildSingleFixPrompt(comment));
    if (ok) {
      toast.success("Launched agent to fix the comment");
      onOpenChange(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open && comment !== null}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix review comment</DialogTitle>
          <DialogDescription>
            Launch an agent to verify and fix this comment in the code.
          </DialogDescription>
        </DialogHeader>

        {comment ? (
          <blockquote className="max-h-32 overflow-auto rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300">
            <p className="mb-1 font-mono text-[10px] text-slate-500">{commentLocation(comment)}</p>
            <p className="whitespace-pre-wrap break-words">{comment.body}</p>
          </blockquote>
        ) : null}

        <FixAgentControls launcher={launcher} />

        {launcher.error ? <p className="text-xs text-destructive">{launcher.error}</p> : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Cancel
          </Button>
          <Button disabled={!launcher.canLaunch} onClick={() => void submit()} size="sm">
            {launcher.busy ? <Loader2 className="animate-spin" /> : null}
            {launcher.newWorktree.enabled ? "Create worktree & fix" : "Launch fix"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
