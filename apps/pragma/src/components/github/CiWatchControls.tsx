import { useState } from "react";
import type { CiWatch, CiWatchMode } from "@pragma-sh/constants";
import { ChevronDown, Eye, GitMerge, Loader2, Merge, Wrench, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import type { MergeActionState } from "@/components/github/MergeActionControls";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentSelection } from "@/hooks/use-agent-selection";
import { useAgentsList } from "@/hooks/use-agents-list";
import { errorMessage } from "@/lib/errors";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";
import { armCiWatch, clearCiWatch } from "@/lib/tauri";
import {
  CI_WATCH_MAX_FIX_ATTEMPTS,
  ciWatches,
  isCiWatchOffered,
  isLiveCiWatch,
  isShownCiWatch,
  stoppedCiWatchTitle,
  useCiWatch,
  type CiWatchView,
} from "@/state/ci-watch-store";

const MODE_LABEL: Record<CiWatchMode, string> = {
  watchMerge: "Watch, fix and merge",
  watch: "Watch and fix",
};

/** Forgets a worktree's watch on its host, then locally. */
async function clearWatch(worktreeId: string): Promise<void> {
  try {
    await clearCiWatch(worktreeId);
    ciWatches.remove(worktreeId);
  } catch (cause) {
    toast.error(errorMessage(cause));
  }
}

/**
 * Configures and displays one worktree's CI watch. Arming is offered only
 * while CI is failing or running on a conflict-free PR (`isCiWatchOffered`);
 * then this split button stands in for the merge button: the default arms
 * "watch, fix and merge" (merging once every check passes), and the menu
 * offers watching without merging or a plain merge right now. An existing
 * watch is always shown. The record lives on the host, so `pragma-cli ci`
 * sees it.
 */
export function CiWatchControls({
  pr,
  worktreeId,
  checks,
  merge,
  onMerge,
}: {
  pr: PullRequestSummary;
  worktreeId: string;
  checks: ChecksStatus | null;
  /** The plain merge the menu offers alongside the watch modes. */
  merge: MergeActionState;
  onMerge: () => void;
}) {
  const view = useCiWatch(worktreeId);
  const [setupMode, setSetupMode] = useState<CiWatchMode | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const selection = useAgentSelection(setupMode !== null);
  const watching = isShownCiWatch(view);
  if (!watching && !isCiWatchOffered(pr, checks)) return null;

  async function start() {
    const agent = selection.selectedAgent;
    const mode = setupMode;
    if (!agent || !mode) return;
    setSetupMode(null);
    try {
      const record = await armCiWatch({
        worktreeId,
        mode,
        agentId: agent.id,
        modelId: selection.modelSelection.modelId,
        reasoningId: selection.modelSelection.reasoningId,
        prNumber: pr.number,
      });
      ciWatches.put(record);
      ciWatches.kick();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  return (
    <>
      {watching ? (
        <CiWatchState view={view} onCancel={() => setConfirmCancel(true)} />
      ) : (
        <CiWatchStartButton merge={merge} onChoose={setSetupMode} onMerge={onMerge} />
      )}
      <CiWatchSetupDialog
        mode={setupMode}
        onOpenChange={(open) => {
          if (!open) setSetupMode(null);
        }}
        selection={selection}
        onStart={() => void start()}
      />
      <CancelCiWatchDialog
        merging={view?.record.mode === "watchMerge"}
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        onConfirm={() => void clearWatch(worktreeId)}
      />
    </>
  );
}

/**
 * The split button: "Watch, fix and merge" by default; "Watch and fix" and a
 * plain merge in its menu.
 */
function CiWatchStartButton({
  merge,
  onChoose,
  onMerge,
}: {
  merge: MergeActionState;
  onChoose: (mode: CiWatchMode) => void;
  onMerge: () => void;
}) {
  const mergeBlocked = merge.allowed === false || merge.allowed === undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex w-full">
        <Button
          className="min-w-0 flex-1 rounded-r-none"
          disabled={mergeBlocked}
          onClick={() => onChoose("watchMerge")}
          size="sm"
          variant="outline"
        >
          <GitMerge />
          {MODE_LABEL.watchMerge}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              aria-label="More CI watch options"
              className="rounded-l-none border-l-0 px-2"
              label="More options"
              size="sm"
              variant="outline"
            >
              <ChevronDown />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem disabled={mergeBlocked} onSelect={() => onChoose("watchMerge")}>
              <GitMerge />
              <div className="flex flex-col">
                <span>{MODE_LABEL.watchMerge}</span>
                <span className="text-xs text-muted-foreground">
                  Fix failures, then merge once every check passes
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onChoose("watch")}>
              <Eye />
              <div className="flex flex-col">
                <span>{MODE_LABEL.watch}</span>
                <span className="text-xs text-muted-foreground">
                  Fix failures; you merge yourself
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={merge.disabled} onSelect={onMerge}>
              {merge.merging ? <Loader2 className="animate-spin" /> : <Merge />}
              <div className="flex flex-col">
                <span>{merge.label}</span>
                <span className="text-xs text-muted-foreground">
                  Merge now, without waiting for checks
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {merge.allowed === false ? (
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to merge pull requests in {merge.target.owner}/
          {merge.target.repo}. Watch and fix is still available from the menu.
        </p>
      ) : null}
    </div>
  );
}

function liveLabel(view: CiWatchView): string {
  const { record } = view;
  if (view.launching) return "Starting CI fix…";
  if (record.status === "merging") return "Checks passed — merging, too late to cancel…";
  if (record.status === "fixing") {
    return `Fixing CI · attempt ${record.attempts} of ${CI_WATCH_MAX_FIX_ATTEMPTS}`;
  }
  return record.mode === "watchMerge" ? "Watching CI · merges when all checks pass" : "Watching CI";
}

function PhaseIcon({ view }: { view: CiWatchView }) {
  if (view.launching || view.record.status === "merging") {
    return <Loader2 aria-hidden className="size-3.5 animate-spin" />;
  }
  if (view.record.status === "fixing") return <Wrench aria-hidden className="size-3.5" />;
  if (view.record.mode === "watchMerge") {
    return <GitMerge aria-hidden className="size-3.5 text-muted-foreground" />;
  }
  return <Eye aria-hidden className="size-3.5 text-muted-foreground" />;
}

function CiWatchState({ view, onCancel }: { view: CiWatchView; onCancel: () => void }) {
  const agents = useAgentsList();
  const agentName = agents.find((agent) => agent.id === view.record.agentId)?.name;
  if (!isLiveCiWatch(view.record)) return <CiWatchStopped record={view.record} />;
  return (
    <div className="flex flex-col gap-1">
      <output className="flex items-center gap-2 text-xs">
        <PhaseIcon view={view} />
        <span className="min-w-0 flex-1">
          <span className="block">{liveLabel(view)}</span>
          <span className="block break-words text-muted-foreground">
            {agentName ?? view.record.agentId} · {view.record.modelId ?? "Default model"}
          </span>
        </span>
        {view.record.status === "merging" ? null : (
          <IconButton label="Cancel watch" size="icon-sm" variant="ghost" onClick={onCancel}>
            <X />
          </IconButton>
        )}
      </output>
      {view.error ? (
        <p role="alert" className="text-xs text-destructive">
          {view.error} Retrying automatically.
        </p>
      ) : null}
    </div>
  );
}

/** A failed or disarmed watch: the full reason, and a way to dismiss it. */
function CiWatchStopped({ record }: { record: CiWatch }) {
  const by =
    record.status === "disarmed"
      ? "Disarmed by the fix agent or pragma-cli"
      : `Stopped after ${record.attempts} of ${CI_WATCH_MAX_FIX_ATTEMPTS} fix attempts`;
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <XCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">{stoppedCiWatchTitle(record)}</p>
          <p className="text-muted-foreground">{by}</p>
        </div>
      </div>
      {record.error ? (
        <p className="break-words whitespace-pre-wrap text-foreground">{record.error}</p>
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void clearWatch(record.worktreeId)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function CiWatchSetupDialog({
  mode,
  onOpenChange,
  selection,
  onStart,
}: {
  mode: CiWatchMode | null;
  onOpenChange: (open: boolean) => void;
  selection: ReturnType<typeof useAgentSelection>;
  onStart: () => void;
}) {
  const merges = mode === "watchMerge";
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{MODE_LABEL[mode ?? "watch"]}</DialogTitle>
          <DialogDescription>
            Watch this pull request for failed checks. The selected agent will open in a new tab,
            fix failures, then commit and push; its tab closes when fresh CI checks appear. After{" "}
            {CI_WATCH_MAX_FIX_ATTEMPTS} attempts that still fail, the watch stops and the sidebar
            says why.
            {merges
              ? " Once every check passes, Pragma merges the pull request."
              : " You merge the pull request yourself."}{" "}
            Watching runs while this app is open.
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
  merging,
  open,
  onOpenChange,
  onConfirm,
}: {
  merging: boolean;
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
            Stop watching this pull request and launching fixes
            {merging ? ", and don't merge it when checks pass" : ""}. An agent tab already running
            will stay open and will no longer close automatically.
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
