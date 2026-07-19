import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { BranchSyncStatus, ChangedFile, WorktreeChanges } from "@pragma/constants";
import { ArrowDown, ArrowUp, Minus, Plus, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { WorktreeDeleteDialog } from "@/components/dialogs/WorktreeDeleteDialog";
import {
  ChangeGroup,
  type ChangeFileAction,
  type ChangeGroupAction,
} from "@/components/right-sidebar/ChangeGroup";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { basename } from "@/lib/path";
import {
  aiGenerateCommitMessage,
  commitStaged,
  discardAllUnstaged,
  discardUnstagedFile,
  githubFetchAndSync,
  githubSyncBranch,
  stageAll,
  stageFile,
  unstageAll,
  unstageFile,
  worktreeChanges,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { useWorkspace } from "@/state/workspace-context";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; changes: WorktreeChanges }
  | { kind: "error"; message: string };

/** A pending, confirmation-gated discard: one unstaged file, or all of them. */
type PendingDiscard = { kind: "file"; file: ChangedFile } | { kind: "all" };

type StagingOp = (worktreeId: string) => Promise<void>;

/**
 * How often the Changes subtab re-queries git while it is mounted. Git has no
 * push notification for working-tree edits, so we poll; refreshes after the
 * first load update the lists in place without flashing the loading state.
 */
const CHANGES_REFRESH_INTERVAL_MS = 2000;
const BRANCH_SYNC_REFRESH_INTERVAL_MS = 10_000;

/** True when two polled change sets are identical, so state can be kept as-is. */
function sameChanges(a: WorktreeChanges, b: WorktreeChanges): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Run a single discard target (one file or all unstaged), surfacing the toast. */
async function applyDiscard(worktreeId: string, target: PendingDiscard): Promise<void> {
  if (target.kind === "all") {
    await discardAllUnstaged(worktreeId);
    toast.success("Discarded all unstaged changes");
    return;
  }
  const file = target.file;
  await discardUnstagedFile(worktreeId, file.path, file.status, file.oldPath);
  toast.success(`Discarded changes to ${basename(file.path)}`);
}

/** Build the staged-file action set (unstage one / unstage all). */
function buildStagedActions(runStaging: (op: StagingOp, success: string) => void): {
  fileActions: ChangeFileAction[];
  headerActions: ChangeGroupAction[];
} {
  return {
    fileActions: [
      {
        icon: Minus,
        label: (file) => `Unstage ${basename(file.path)}`,
        title: "Unstage changes",
        onClick: (file) =>
          void runStaging(
            (id) => unstageFile(id, file.path, file.oldPath),
            `Unstaged ${basename(file.path)}`,
          ),
      },
    ],
    headerActions: [
      {
        icon: Minus,
        label: "Unstage all changes",
        title: "Unstage all changes",
        onClick: () => void runStaging(unstageAll, "Unstaged all changes"),
      },
    ],
  };
}

/** Build the unstaged-file action set (stage/discard one, stage/discard all). */
function buildUnstagedActions(
  runStaging: (op: StagingOp, success: string) => void,
  setPending: (pending: PendingDiscard | null) => void,
): {
  fileActions: ChangeFileAction[];
  headerActions: ChangeGroupAction[];
} {
  return {
    fileActions: [
      {
        icon: Plus,
        label: (file) => `Stage ${basename(file.path)}`,
        title: "Stage changes",
        onClick: (file) =>
          void runStaging((id) => stageFile(id, file.path), `Staged ${basename(file.path)}`),
      },
      {
        icon: Undo2,
        label: (file) => `Discard changes to ${basename(file.path)}`,
        title: "Discard changes",
        onClick: (file) => setPending({ kind: "file", file }),
      },
    ],
    headerActions: [
      {
        icon: Plus,
        label: "Stage all changes",
        title: "Stage all changes",
        onClick: () => void runStaging(stageAll, "Staged all changes"),
      },
      {
        icon: Undo2,
        label: "Discard all unstaged changes",
        title: "Discard all changes",
        onClick: () => setPending({ kind: "all" }),
      },
    ],
  };
}

/** Whether the top controls should switch from commit to sync/delete. */
function computeCanSyncOrDelete(
  selectedWorktree: { isMain: boolean; parentId: string | null } | null,
  changes: WorktreeChanges,
  syncStatus: BranchSyncStatus | null,
): boolean {
  if (changes.staged.length > 0 || changes.unstaged.length > 0) return false;
  if (changes.committed.length > 0) return true;
  if (syncStatus && (syncStatus.ahead > 0 || syncStatus.behind > 0)) return true;
  return Boolean(selectedWorktree && !selectedWorktree.isMain && selectedWorktree.parentId);
}

/** Resolve the current worktree's display label for the delete button. */
function resolveWorktreeLabel(
  selectedWorktree: { title: string | null; branch: string } | null,
): string {
  return selectedWorktree?.title ?? selectedWorktree?.branch ?? "worktree";
}

/** Polls `worktreeChanges` for the selected worktree, dropping stale responses. */
function useChangesRefresh(worktreeId: string | null): {
  state: LoadState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // The worktree whose load is current; in-flight responses for a stale
  // worktree are dropped so a slow poll can't overwrite a newer selection.
  const activeWorktree = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreeId) return;
    try {
      const changes = await worktreeChanges(worktreeId);
      if (activeWorktree.current === worktreeId) {
        // Keep the previous state object when nothing changed so the 2s poll
        // doesn't re-render the whole tab every tick.
        setState((previous) =>
          previous.kind === "ready" && sameChanges(previous.changes, changes)
            ? previous
            : { kind: "ready", changes },
        );
      }
    } catch (cause) {
      if (activeWorktree.current === worktreeId)
        setState({ kind: "error", message: errorMessage(cause) });
    }
  }, [worktreeId]);

  useEffect(() => {
    activeWorktree.current = worktreeId;
    if (!worktreeId) {
      setState({ kind: "loading" });
      return;
    }
    // Reset to loading only when the worktree changes; subsequent polls and
    // focus-driven refreshes replace the lists in place.
    setState({ kind: "loading" });
    return startRefreshLoop(refresh, CHANGES_REFRESH_INTERVAL_MS);
  }, [worktreeId, refresh]);

  return { state, refresh };
}

/** Reversible staging operations (stage/unstage one or all) + the action sets. */
function useChangesStaging(
  worktreeId: string | null,
  refresh: () => Promise<void>,
  setPending: (pending: PendingDiscard | null) => void,
): {
  stagedActions: { fileActions: ChangeFileAction[]; headerActions: ChangeGroupAction[] };
  unstagedActions: { fileActions: ChangeFileAction[]; headerActions: ChangeGroupAction[] };
} {
  const runStaging = useCallback(
    async (op: StagingOp, success: string) => {
      if (!worktreeId) return;
      try {
        await op(worktreeId);
        toast.success(success);
        await refresh();
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [worktreeId, refresh],
  );
  const stagedActions = useMemo(() => buildStagedActions(runStaging), [runStaging]);
  const unstagedActions = useMemo(
    () => buildUnstagedActions(runStaging, setPending),
    [runStaging, setPending],
  );
  return { stagedActions, unstagedActions };
}

/** Commit-message input state and the commit / AI-generate handlers. */
function useChangesCommit(
  worktreeId: string | null,
  refresh: () => Promise<void>,
  stagedCount: number,
): {
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  committing: boolean;
  generating: boolean;
  onSubmit: () => void;
  onGenerate: () => void;
} {
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  // The half-typed commit message belongs to one worktree's staged files, not
  // the next, so it is dropped on switch.
  useEffect(() => {
    setCommitMessage("");
  }, [worktreeId]);

  const onSubmit = useCallback(async () => {
    if (!worktreeId || committing) return;
    const message = commitMessage.trim();
    if (!message) return;
    setCommitting(true);
    try {
      await commitStaged(worktreeId, message);
      setCommitMessage("");
      toast.success("Committed staged changes");
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setCommitting(false);
    }
  }, [worktreeId, commitMessage, committing, refresh]);

  const onGenerate = useCallback(async () => {
    if (!worktreeId || generating) return;
    if (stagedCount === 0) {
      toast.error("No staged changes to generate a commit message from.");
      return;
    }
    setGenerating(true);
    try {
      const message = await aiGenerateCommitMessage(worktreeId);
      setCommitMessage(message);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setGenerating(false);
    }
  }, [worktreeId, generating, stagedCount]);

  return { commitMessage, setCommitMessage, committing, generating, onSubmit, onGenerate };
}

/** Confirmation-gated discard of one unstaged file or all of them. */
function useChangesDiscard(
  worktreeId: string | null,
  refresh: () => Promise<void>,
): {
  pending: PendingDiscard | null;
  setPending: (pending: PendingDiscard | null) => void;
  onConfirmDiscard: () => void;
  closeDiscard: () => void;
} {
  const [pending, setPending] = useState<PendingDiscard | null>(null);
  const onConfirmDiscard = useCallback(async () => {
    const target = pending;
    setPending(null);
    if (!target || !worktreeId) return;
    try {
      await applyDiscard(worktreeId, target);
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, [pending, worktreeId, refresh]);
  const closeDiscard = useCallback(() => setPending(null), []);
  return { pending, setPending, onConfirmDiscard, closeDiscard };
}

/** Polls remote branch counts for the compact sync control. */
function useBranchSyncStatus(worktreeId: string | null): {
  status: BranchSyncStatus | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<BranchSyncStatus | null>(null);
  const activeWorktree = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    if (!worktreeId) return;
    try {
      const next = await githubFetchAndSync(worktreeId);
      if (activeWorktree.current === worktreeId) setStatus(next);
    } catch {
      if (activeWorktree.current === worktreeId) setStatus(null);
    }
  }, [worktreeId]);
  useEffect(() => {
    activeWorktree.current = worktreeId;
    setStatus(null);
    if (!worktreeId) return;
    return startRefreshLoop(refresh, BRANCH_SYNC_REFRESH_INTERVAL_MS);
  }, [worktreeId, refresh]);
  return { status, refresh };
}

/** Pulls then pushes the branch, surfacing conflicts inline and via toast. */
function useChangesSync(
  worktreeId: string | null,
  refreshChanges: () => Promise<void>,
  refreshStatus: () => Promise<void>,
): {
  syncing: boolean;
  syncError: string | null;
  onSync: () => void;
} {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  useEffect(() => {
    setSyncError(null);
  }, [worktreeId]);

  const onSync = useCallback(async () => {
    if (!worktreeId || syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await githubSyncBranch(worktreeId);
      toast.success("Synced branch with remote");
      await Promise.all([refreshChanges(), refreshStatus()]);
    } catch (cause) {
      const message = errorMessage(cause);
      setSyncError(message);
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  }, [worktreeId, syncing, refreshChanges, refreshStatus]);

  return { syncing, syncError, onSync };
}

/** Combines staging, commit, discard, and sync interactions for the Changes subtab. */
function useChangesActions(
  worktreeId: string | null,
  refresh: () => Promise<void>,
  refreshSyncStatus: () => Promise<void>,
  stagedCount: number,
): {
  pending: PendingDiscard | null;
  setPending: (pending: PendingDiscard | null) => void;
  onConfirmDiscard: () => void;
  closeDiscard: () => void;
  stagedActions: { fileActions: ChangeFileAction[]; headerActions: ChangeGroupAction[] };
  unstagedActions: { fileActions: ChangeFileAction[]; headerActions: ChangeGroupAction[] };
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  committing: boolean;
  generating: boolean;
  onSubmit: () => void;
  onGenerate: () => void;
  syncing: boolean;
  syncError: string | null;
  onSync: () => void;
} {
  const { pending, setPending, onConfirmDiscard, closeDiscard } = useChangesDiscard(
    worktreeId,
    refresh,
  );
  const { stagedActions, unstagedActions } = useChangesStaging(worktreeId, refresh, setPending);
  const { commitMessage, setCommitMessage, committing, generating, onSubmit, onGenerate } =
    useChangesCommit(worktreeId, refresh, stagedCount);
  const { syncing, syncError, onSync } = useChangesSync(worktreeId, refresh, refreshSyncStatus);
  return {
    pending,
    setPending,
    onConfirmDiscard,
    closeDiscard,
    stagedActions,
    unstagedActions,
    commitMessage,
    setCommitMessage,
    committing,
    generating,
    onSubmit,
    onGenerate,
    syncing,
    syncError,
    onSync,
  };
}

/**
 * The Changes subtab: top lifecycle controls, then staged (HEAD → index),
 * unstaged (index → working tree), and committed (base branch → HEAD) change
 * lists, each a default-open collapsible (in that order). Clicking a file in any
 * list opens a single read-only diff tab comparing its current working-tree
 * content against what used to be on the worktree at its fork point (the
 * `worktree` diff side), folding committed + staged + unstaged changes into one
 * review view. Unstaged files can be staged
 * or discarded; staged files can be unstaged or committed. Once a child
 * worktree has only committed changes, the top controls switch to remote sync,
 * then to the shared delete-worktree dialog after the committed diff is gone.
 */
export function ChangesTab() {
  const workspace = useWorkspace();
  const { available: aiAvailable } = useAi();
  const worktreeId = workspace.selectedWorktreeId;

  const { state, refresh } = useChangesRefresh(worktreeId);
  const shouldLoadSyncStatus =
    state.kind === "ready" &&
    state.changes.staged.length === 0 &&
    state.changes.unstaged.length === 0;
  const { status: syncStatus, refresh: refreshSyncStatus } = useBranchSyncStatus(
    shouldLoadSyncStatus ? worktreeId : null,
  );
  const stagedCount = state.kind === "ready" ? state.changes.staged.length : 0;
  const {
    pending,
    onConfirmDiscard,
    closeDiscard,
    stagedActions,
    unstagedActions,
    commitMessage,
    setCommitMessage,
    committing,
    generating,
    onSubmit,
    onGenerate,
    syncing,
    syncError,
    onSync,
  } = useChangesActions(worktreeId, refresh, refreshSyncStatus, stagedCount);

  const openDiff = useCallback(
    (file: ChangedFile) => void workspace.openDiffTab(file.path, "worktree"),
    [workspace],
  );

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Select a worktree to see its changes.
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Loading changes…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-destructive">
        {state.message}
      </div>
    );
  }

  const changes = state.changes;
  const selectedWorktree = workspace.selectedWorktree;
  const canSyncOrDelete = computeCanSyncOrDelete(selectedWorktree, changes, syncStatus);
  const worktreeLabel = resolveWorktreeLabel(selectedWorktree);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto py-1">
      <ChangesTopAction
        aiAvailable={aiAvailable}
        canSyncOrDelete={canSyncOrDelete}
        commitMessage={commitMessage}
        committedCount={changes.committed.length}
        generating={generating}
        syncing={syncing}
        syncError={syncError}
        syncStatus={syncStatus}
        onCommitMessageChange={setCommitMessage}
        onGenerate={onGenerate}
        onSync={onSync}
        onSubmit={onSubmit}
        selectedWorktree={selectedWorktree}
        stagedCount={changes.staged.length}
        worktreeLabel={worktreeLabel}
        busy={committing || generating}
      />
      <ChangeGroup
        emptyLabel="No staged changes"
        fileActions={stagedActions.fileActions}
        files={changes.staged}
        headerActions={stagedActions.headerActions}
        onOpen={openDiff}
        title="Staged changes"
      />
      <ChangeGroup
        emptyLabel="No unstaged changes"
        fileActions={unstagedActions.fileActions}
        files={changes.unstaged}
        headerActions={unstagedActions.headerActions}
        onOpen={openDiff}
        title="Unstaged changes"
      />
      <ChangeGroup
        emptyLabel="No committed changes"
        files={changes.committed}
        onOpen={openDiff}
        title="Committed changes"
      />
      <DiscardConfirmDialog onConfirm={onConfirmDiscard} onClose={closeDiscard} pending={pending} />
    </div>
  );
}

interface ChangesTopActionProps {
  aiAvailable: boolean;
  canSyncOrDelete: boolean;
  commitMessage: string;
  committedCount: number;
  generating: boolean;
  syncing: boolean;
  syncError: string | null;
  syncStatus: BranchSyncStatus | null;
  onCommitMessageChange: (value: string) => void;
  onGenerate: () => void;
  onSync: () => void;
  onSubmit: () => void;
  selectedWorktree: { id: string } | null;
  stagedCount: number;
  worktreeLabel: string;
  busy: boolean;
}

/** Render the sync or delete control when the worktree is fully committed. */
function renderSyncAction(
  committedCount: number,
  selectedWorktree: { id: string } | null,
  syncing: boolean,
  syncError: string | null,
  syncStatus: BranchSyncStatus | null,
  onSync: () => void,
  worktreeLabel: string,
): ReactNode {
  if (committedCount > 0 || (syncStatus && (syncStatus.ahead > 0 || syncStatus.behind > 0))) {
    return <SyncAction disabled={syncing} error={syncError} onSync={onSync} status={syncStatus} />;
  }
  if (selectedWorktree) {
    return <MergedDeleteAction worktreeId={selectedWorktree.id} worktreeLabel={worktreeLabel} />;
  }
  return null;
}

/** Top-of-tab control: commit input, or sync/delete once staged+unstaged clear. */
function ChangesTopAction({
  aiAvailable,
  canSyncOrDelete,
  commitMessage,
  committedCount,
  generating,
  syncing,
  syncError,
  syncStatus,
  onCommitMessageChange,
  onGenerate,
  onSync,
  onSubmit,
  selectedWorktree,
  stagedCount,
  worktreeLabel,
  busy,
}: ChangesTopActionProps) {
  if (canSyncOrDelete) {
    return renderSyncAction(
      committedCount,
      selectedWorktree,
      syncing,
      syncError,
      syncStatus,
      onSync,
      worktreeLabel,
    );
  }
  return (
    <CommitInput
      aiAvailable={aiAvailable}
      busy={busy}
      generating={generating}
      message={commitMessage}
      onChange={onCommitMessageChange}
      onGenerate={onGenerate}
      onSubmit={onSubmit}
      stagedCount={stagedCount}
    />
  );
}

/** Body text for the discard confirmation dialog. */
function discardDescription(pending: PendingDiscard | null): string {
  if (pending?.kind === "file") {
    return `Unstaged changes to ${basename(pending.file.path)} will be permanently lost.`;
  }
  return "All unstaged changes in this worktree will be permanently lost.";
}

/** Confirmation dialog for discarding one unstaged file or all unstaged changes. */
function DiscardConfirmDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: PendingDiscard | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  return (
    <AlertDialog onOpenChange={handleOpenChange} open={pending !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>{discardDescription(pending)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface SyncActionProps {
  disabled: boolean;
  error: string | null;
  onSync: () => void;
  status: BranchSyncStatus | null;
}

/** Sync action, styled like the commit button: full-width with pull/push counts. */
function SyncAction({ disabled, error, onSync, status }: SyncActionProps) {
  const behind = status?.behind ?? 0;
  const ahead = status?.ahead ?? 0;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-2 py-2">
      <Button
        aria-label="Sync with remote"
        className="h-7 w-full"
        disabled={disabled}
        onClick={onSync}
        size="sm"
        title="Sync with remote (pull, then push)"
        variant="default"
      >
        <span className="inline-flex items-center gap-px" title={`${behind} commit(s) to pull`}>
          <ArrowDown className="size-3.5" /> {behind}
        </span>
        <span className="inline-flex items-center gap-px" title={`${ahead} commit(s) to push`}>
          <ArrowUp className="size-3.5" /> {ahead}
        </span>
        Sync
      </Button>
      {error ? <p className="text-xs leading-relaxed text-destructive">{error}</p> : null}
    </div>
  );
}

function MergedDeleteAction({
  worktreeId,
  worktreeLabel,
}: {
  worktreeId: string;
  worktreeLabel: string;
}) {
  return (
    <div className="border-b border-border/60 px-2 py-2">
      <WorktreeDeleteDialog
        worktreeId={worktreeId}
        worktreeLabel={worktreeLabel}
        trigger={
          <Button className="h-8 w-full" size="sm" variant="destructive">
            Delete worktree
          </Button>
        }
      />
    </div>
  );
}

interface CommitInputProps {
  /** Whether AI is available — gates the Shift+Tab hint and handler. */
  aiAvailable: boolean;
  /** True while committing or generating (disables the input). */
  busy: boolean;
  /** Whether a commit message is currently being generated. */
  generating: boolean;
  message: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onSubmit: () => void;
  /** Number of staged files (gates commit readiness + empty-index disabling). */
  stagedCount: number;
}

/** Resolve the placeholder shown in the commit input for the current state. */
function commitPlaceholder(aiAvailable: boolean, generating: boolean): string {
  if (generating) return "Generating commit message…";
  return aiAvailable ? "Shift + tab to generate" : "Commit message";
}

/** Handle Shift+Tab (AI generate) and ⌘/Ctrl+Enter (submit) in the commit field. */
function handleCommitKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
  aiAvailable: boolean,
  canCommit: boolean,
  trimmed: string,
  onGenerate: () => void,
  onSubmit: () => void,
): void {
  if (aiAvailable && event.shiftKey && event.key === "Tab") {
    event.preventDefault();
    onGenerate();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (canCommit && trimmed.length > 0) onSubmit();
  }
}

/**
 * Commit-message input + button pinned to the top of the Changes subtab. The
 * Commit button is gated on staged work and a non-empty message; ⌘/Ctrl-Enter
 * submits. When AI is available the placeholder advertises "Shift + tab to
 * generate" and Shift+Tab summarizes the staged diff (replacing the placeholder
 * with a generating message); with no provider connected none of that shows.
 */
function CommitInput({
  aiAvailable,
  busy,
  generating,
  message,
  onChange,
  onGenerate,
  onSubmit,
  stagedCount,
}: CommitInputProps) {
  const trimmed = message.trim();
  const canCommit = !busy && stagedCount > 0;
  const disabled = busy || (!aiAvailable && stagedCount === 0);
  const placeholder = commitPlaceholder(aiAvailable, generating);
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-2 py-2">
      <Input
        aria-label="Commit message"
        autoCapitalize="none"
        autoCorrect="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) =>
          handleCommitKeyDown(event, aiAvailable, canCommit, trimmed, onGenerate, onSubmit)
        }
        placeholder={placeholder}
        spellCheck="true"
        value={message}
      />
      <Button
        className="h-7 w-full"
        disabled={!canCommit || trimmed.length === 0}
        onClick={onSubmit}
        size="sm"
        variant="default"
      >
        Commit
      </Button>
    </div>
  );
}
