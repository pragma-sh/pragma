import { useState } from "react";
import type { GitHubRepoRef } from "@pragma-sh/constants";
import { Eye, Loader2, Wrench, X } from "lucide-react";
import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
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
import { useAgentSelection } from "@/hooks/use-agent-selection";
import { modelSelectionLabel } from "@/lib/agent-model-selection";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";
import { ciWatchKey, ciWatches, useCiWatch } from "@/state/ci-watch-store";

/** Configures and displays one PR's automatic CI repair watch. */
export function CiWatchControls({
  repo,
  pr,
  worktreeId,
  checks,
}: {
  repo: GitHubRepoRef;
  pr: PullRequestSummary;
  worktreeId: string;
  checks: ChecksStatus | null;
}) {
  const key = ciWatchKey(worktreeId, repo, pr.number);
  const watch = useCiWatch(key);
  const [setup, setSetup] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const selection = useAgentSelection(setup);
  if (!watch && (!checks?.total || pr.state !== "open" || pr.merged)) return null;

  function start() {
    const agent = selection.selectedAgent;
    if (!agent) return;
    ciWatches.set(key, {
      worktreeId,
      repo,
      prNumber: pr.number,
      headRef: pr.headRef,
      agent,
      modelSelection: { ...selection.modelSelection },
      modelLabel: selection.modelSelection.modelId
        ? modelSelectionLabel(selection.modelsByAgent[agent.id] ?? [], selection.modelSelection)
        : "Default model",
      phase: "watching",
    });
    setSetup(false);
  }

  return (
    <>
      {watch ? (
        <div className="flex flex-col gap-1">
          <output className="flex items-center gap-2 text-xs">
            {watch.phase === "launching" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : watch.phase === "fixing" ? (
              <Wrench aria-hidden className="size-3.5" />
            ) : (
              <Eye aria-hidden className="size-3.5 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block">
                {watch.phase === "fixing"
                  ? "Fixing CI"
                  : watch.phase === "launching"
                    ? "Starting CI fix…"
                    : "Watching CI"}
              </span>
              <span className="block break-words text-muted-foreground">
                {watch.agent.name} · {watch.modelLabel}
              </span>
            </span>
            <IconButton
              label="Cancel watch"
              size="icon-sm"
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
            >
              <X />
            </IconButton>
          </output>
          {watch.error ? (
            <p role="alert" className="text-xs text-destructive">
              {watch.error} Retrying automatically.
            </p>
          ) : null}
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setSetup(true)}>
          <Eye />
          Watch and fix
        </Button>
      )}
      <Dialog open={setup} onOpenChange={setSetup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Watch and fix CI</DialogTitle>
            <DialogDescription>
              Watch this pull request for failed checks. The selected agent will open in a new tab,
              fix failures, then commit and push. Its tab closes when fresh CI checks appear.
              Watching continues until cancelled or the pull request closes, while this app is
              running.
            </DialogDescription>
          </DialogHeader>
          <AgentModelSelector
            agents={selection.agents}
            modelsByAgent={selection.modelsByAgent}
            value={{ agentId: selection.agentId, selection: selection.modelSelection }}
            onChange={selection.handleAgentChange}
            onLoadModels={selection.loadModels}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetup(false)}>
              Cancel
            </Button>
            <Button disabled={!selection.selectedAgent} onClick={start}>
              Start watching
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel CI watch?</AlertDialogTitle>
            <AlertDialogDescription>
              Stop watching this pull request and launching fixes. An agent tab already running will
              stay open and will no longer close automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep watching</AlertDialogCancel>
            <AlertDialogAction onClick={() => ciWatches.cancel(key)}>
              Cancel watch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
