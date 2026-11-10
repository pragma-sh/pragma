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
import { ciWatchKey, ciWatches, useCiWatch, type CiWatch } from "@/state/ci-watch-store";

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
        <CiWatchStatus watch={watch} onCancel={() => setConfirmCancel(true)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setSetup(true)}>
          <Eye />
          Watch and fix
        </Button>
      )}
      <CiWatchSetupDialog
        open={setup}
        onOpenChange={setSetup}
        selection={selection}
        onStart={start}
      />
      <CancelCiWatchDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        onConfirm={() => ciWatches.cancel(key)}
      />
    </>
  );
}

const PHASE_LABEL: Record<CiWatch["phase"], string> = {
  watching: "Watching CI",
  launching: "Starting CI fix…",
  fixing: "Fixing CI",
};

function PhaseIcon({ phase }: { phase: CiWatch["phase"] }) {
  if (phase === "launching") return <Loader2 aria-hidden className="size-3.5 animate-spin" />;
  if (phase === "fixing") return <Wrench aria-hidden className="size-3.5" />;
  return <Eye aria-hidden className="size-3.5 text-muted-foreground" />;
}

function CiWatchStatus({ watch, onCancel }: { watch: CiWatch; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      <output className="flex items-center gap-2 text-xs">
        <PhaseIcon phase={watch.phase} />
        <span className="min-w-0 flex-1">
          <span className="block">{PHASE_LABEL[watch.phase]}</span>
          <span className="block break-words text-muted-foreground">
            {watch.agent.name} · {watch.modelLabel}
          </span>
        </span>
        <IconButton label="Cancel watch" size="icon-sm" variant="ghost" onClick={onCancel}>
          <X />
        </IconButton>
      </output>
      {watch.error ? (
        <p role="alert" className="text-xs text-destructive">
          {watch.error} Retrying automatically.
        </p>
      ) : null}
    </div>
  );
}

function CiWatchSetupDialog({
  open,
  onOpenChange,
  selection,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: ReturnType<typeof useAgentSelection>;
  onStart: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Watch and fix CI</DialogTitle>
          <DialogDescription>
            Watch this pull request for failed checks. The selected agent will open in a new tab,
            fix failures, then commit and push. Its tab closes when fresh CI checks appear. Watching
            continues until cancelled or the pull request closes, while this app is running.
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selection.selectedAgent} onClick={onStart}>
            Start watching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelCiWatchDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          <AlertDialogAction onClick={onConfirm}>Cancel watch</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
