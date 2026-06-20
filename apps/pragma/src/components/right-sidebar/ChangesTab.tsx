import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChangedFile, WorktreeChanges } from "@pragma/constants";
import { GitMerge, Minus, Plus, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { WorktreeDeleteDialog } from "@/components/dialogs/WorktreeDeleteDialog";
import {
  ChangeGroup,
  type ChangeFileAction,
  type ChangeGroupAction,
} from "@/components/right-sidebar/ChangeGroup";
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
  commitStaged,
  discardAllUnstaged,
  discardUnstagedFile,
  mergeWorktreeToParent,
  stageAll,
  stageFile,
  unstageAll,
  unstageFile,
  worktreeChanges,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; changes: WorktreeChanges }
  | { kind: "error"; message: string };

/** A pending, confirmation-gated discard: one unstaged file, or all of them. */
type PendingDiscard = { kind: "file"; file: ChangedFile } | { kind: "all" };

/**
 * How often the Changes subtab re-queries git while it is mounted. Git has no
 * push notification for working-tree edits, so we poll; refreshes after the
 * first load update the lists in place without flashing the loading state.
 */
const CHANGES_REFRESH_INTERVAL_MS = 2000;

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
 * worktree has only committed changes, the top controls switch to merge, then
 * to the shared delete-worktree dialog after the committed diff is gone.
 */
export function ChangesTab() {
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktreeId;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pending, setPending] = useState<PendingDiscard | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // The worktree whose load is current; in-flight responses for a stale
  // worktree are dropped so a slow poll can't overwrite a newer selection.
  const activeWorktree = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!worktreeId) {
      return;
    }
    try {
      const changes = await worktreeChanges(worktreeId);
      if (activeWorktree.current === worktreeId) {
        setState({ kind: "ready", changes });
      }
    } catch (cause) {
      if (activeWorktree.current === worktreeId) {
        setState({ kind: "error", message: messageFor(cause) });
      }
    }
  }, [worktreeId]);

  useEffect(() => {
    activeWorktree.current = worktreeId;
    if (!worktreeId) {
      setState({ kind: "loading" });
      return;
    }
    // Reset to the loading state only when the worktree changes; subsequent
    // polls and focus-driven refreshes replace the lists in place. The
    // half-typed commit message is dropped on switch — it belongs to one
    // worktree's set of staged files, not the next.
    setState({ kind: "loading" });
    setCommitMessage("");
    setMergeError(null);
    void refresh();
    const interval = setInterval(() => void refresh(), CHANGES_REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [worktreeId, refresh]);

  const confirmDiscard = useCallback(async () => {
    const target = pending;
    setPending(null);
    if (!target || !worktreeId) {
      return;
    }
    try {
      if (target.kind === "all") {
        await discardAllUnstaged(worktreeId);
        toast.success("Discarded all unstaged changes");
      } else {
        const file = target.file;
        await discardUnstagedFile(worktreeId, file.path, file.status, file.oldPath);
        toast.success(`Discarded changes to ${basename(file.path)}`);
      }
      await refresh();
    } catch (cause) {
      toast.error(messageFor(cause));
    }
  }, [pending, worktreeId, refresh]);

  // Runs a (non-destructive) staging operation, then refreshes the lists in
  // place. Staging needs no confirmation — it is fully reversible.
  const runStaging = useCallback(
    async (op: (worktreeId: string) => Promise<void>, success: string) => {
      if (!worktreeId) {
        return;
      }
      try {
        await op(worktreeId);
        toast.success(success);
        await refresh();
      } catch (cause) {
        toast.error(messageFor(cause));
      }
    },
    [worktreeId, refresh],
  );

  const submitCommit = useCallback(async () => {
    if (!worktreeId || committing) {
      return;
    }
    const message = commitMessage.trim();
    if (!message) {
      return;
    }
    setCommitting(true);
    try {
      await commitStaged(worktreeId, message);
      setCommitMessage("");
      toast.success("Committed staged changes");
      await refresh();
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setCommitting(false);
    }
  }, [worktreeId, commitMessage, committing, refresh]);

  const submitMerge = useCallback(async () => {
    if (!worktreeId || merging) {
      return;
    }
    setMerging(true);
    setMergeError(null);
    try {
      await mergeWorktreeToParent(worktreeId);
      toast.success("Merged worktree into parent");
      await refresh();
    } catch (cause) {
      const message = messageFor(cause);
      setMergeError(message);
      toast.error(message);
    } finally {
      setMerging(false);
    }
  }, [worktreeId, merging, refresh]);

  const stagedActions = useMemo<{
    fileActions: ChangeFileAction[];
    headerActions: ChangeGroupAction[];
  }>(
    () => ({
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
    }),
    [runStaging],
  );

  const unstagedActions = useMemo<{
    fileActions: ChangeFileAction[];
    headerActions: ChangeGroupAction[];
  }>(
    () => ({
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
    }),
    [runStaging],
  );

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-500">
        Select a worktree to see its changes.
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-500">
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

  const selectedWorktree = workspace.selectedWorktree;
  const canMergeOrDelete = Boolean(
    selectedWorktree &&
    !selectedWorktree.isMain &&
    selectedWorktree.parentId &&
    state.changes.staged.length === 0 &&
    state.changes.unstaged.length === 0,
  );
  const parentWorktree = selectedWorktree?.parentId
    ? (workspace.worktrees[selectedWorktree.projectId] ?? []).find(
        (worktree) => worktree.id === selectedWorktree.parentId,
      )
    : null;
  const parentLabel = parentWorktree?.title ?? parentWorktree?.branch ?? "parent";
  const worktreeLabel = selectedWorktree?.title ?? selectedWorktree?.branch ?? "worktree";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto py-1">
      {canMergeOrDelete ? (
        state.changes.committed.length > 0 ? (
          <MergeAction
            disabled={merging}
            error={mergeError}
            onMerge={() => void submitMerge()}
            parentLabel={parentLabel}
          />
        ) : selectedWorktree ? (
          <MergedDeleteAction worktreeId={selectedWorktree.id} worktreeLabel={worktreeLabel} />
        ) : null
      ) : (
        <CommitInput
          disabled={committing || state.changes.staged.length === 0}
          message={commitMessage}
          onChange={setCommitMessage}
          onSubmit={() => void submitCommit()}
        />
      )}
      <ChangeGroup
        emptyLabel="No staged changes"
        fileActions={stagedActions.fileActions}
        files={state.changes.staged}
        headerActions={stagedActions.headerActions}
        onOpen={(file) => void workspace.openDiffTab(file.path, "worktree")}
        title="Staged changes"
      />
      <ChangeGroup
        emptyLabel="No unstaged changes"
        fileActions={unstagedActions.fileActions}
        files={state.changes.unstaged}
        headerActions={unstagedActions.headerActions}
        onOpen={(file) => void workspace.openDiffTab(file.path, "worktree")}
        title="Unstaged changes"
      />
      <ChangeGroup
        emptyLabel="No committed changes"
        files={state.changes.committed}
        onOpen={(file) => void workspace.openDiffTab(file.path, "worktree")}
        title="Committed changes"
      />
      <AlertDialog onOpenChange={(open) => !open && setPending(null)} open={pending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "file"
                ? `Unstaged changes to ${basename(pending.file.path)} will be permanently lost.`
                : "All unstaged changes in this worktree will be permanently lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDiscard()}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface MergeActionProps {
  disabled: boolean;
  error: string | null;
  onMerge: () => void;
  parentLabel: string;
}

/** Merge action shown after all staged/unstaged work has been committed. */
function MergeAction({ disabled, error, onMerge, parentLabel }: MergeActionProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 px-2 py-2">
      <Button className="h-8 w-full" disabled={disabled} onClick={onMerge} size="sm">
        <GitMerge data-icon="inline-start" />
        {disabled ? "Merging…" : `Merge into ${parentLabel}`}
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
  disabled: boolean;
  message: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

/**
 * Commit-message input + button pinned to the top of the Changes subtab.
 * The input is disabled while there is no staged work to commit (the gate
 * that actually matters for `git commit`); the button is the second gate,
 * held off until the message is non-empty. ⌘/Ctrl-Enter submits from the
 * input as a keyboard shortcut.
 */
function CommitInput({ disabled, message, onChange, onSubmit }: CommitInputProps) {
  const trimmed = message.trim();
  const canSubmit = !disabled && trimmed.length > 0;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-2 py-2">
      <Input
        aria-label="Commit message"
        autoCapitalize="none"
        autoCorrect="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (canSubmit) {
              onSubmit();
            }
          }
        }}
        placeholder="Commit message"
        spellCheck="true"
        value={message}
      />
      <Button
        className="h-7 w-full"
        disabled={!canSubmit}
        onClick={onSubmit}
        size="sm"
        variant="default"
      >
        Commit
      </Button>
    </div>
  );
}
