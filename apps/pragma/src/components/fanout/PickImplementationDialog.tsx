import type { Fanout, FanoutPickResult } from "@pragma/constants";
import { useState } from "react";
import { toast } from "sonner";

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
import { errorMessage } from "@/lib/errors";
import { memberLabel, orderedMembers } from "@/lib/fanout";
import { useFanouts } from "@/state/fanouts-context";
import { useWorkspace } from "@/state/workspace-context";

interface PickImplementationDialogProps {
  fanout: Fanout;
  memberId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirmation for the destructive finalize.
 *
 * It names everything the operation will do before it does any of it: what is
 * merged where, that uncommitted work is committed under an AI-written message,
 * which scratchpads move, and every worktree, branch, and session that is
 * deleted — the winner's included. There is no undo, so the summary is the
 * safety mechanism.
 */
export function PickImplementationDialog({
  fanout,
  memberId,
  open,
  onOpenChange,
}: PickImplementationDialogProps) {
  const fanouts = useFanouts();
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FanoutPickResult | null>(null);
  const winner = fanout.members.find((member) => member.id === memberId);
  const members = orderedMembers(fanout);

  async function run() {
    setBusy(true);
    try {
      const outcome = await fanouts.pick(fanout.id, memberId);
      setResult(outcome);
      if (outcome.stage === "completed") {
        onOpenChange(false);
        setResult(null);
        fanouts.closeComparison();
        void workspace.selectWorktree(fanout.parentWorktreeId);
        toast.success(`Kept ${winner ? memberLabel(winner) : "the selected attempt"}.`);
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Keep {winner ? memberLabel(winner) : "this implementation"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                This cannot be undone. Pragma will merge the winner into the parent, copy its
                scratchpads, and delete every attempt below (winner included), committing any
                uncommitted winner work under an AI-generated message.
              </p>
              <ul className="list-disc space-y-1 pl-5 font-mono text-xs">
                {members.map((member) => (
                  <li key={member.id}>
                    {memberLabel(member)} · {member.branch}
                    {member.id === memberId ? " (winner — also deleted)" : ""}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                A merge conflict stops before anything is deleted and leaves every attempt in place.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {result ? <PickOutcome result={result} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button disabled={busy} variant="destructive" onClick={() => void run()}>
            {busy ? "Finalizing…" : result ? "Retry" : "Pick and delete attempts"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What a stopped or partly-finished finalize left behind, and how to resume. */
function PickOutcome({ result }: { result: FanoutPickResult }) {
  if (result.stage === "merging") {
    return (
      <p className="text-sm text-destructive">
        The merge stopped on conflicts. Resolve them in the parent worktree, then run this again —
        nothing has been promoted or deleted.
      </p>
    );
  }
  if (result.survivingWorktreeIds.length > 0) {
    return (
      <p className="text-sm text-destructive">
        Merged and promoted, but {result.survivingWorktreeIds.length} attempt checkout(s) could not
        be deleted. Running this again retries only those deletions.
      </p>
    );
  }
  return (
    <p className="text-sm text-destructive">
      Finalization stopped at “{result.stage}”.{" "}
      {result.failures[0]?.message ?? "Resolve the reported problem and run it again."}
    </p>
  );
}
