import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { ChangedFile, WorktreeCommit } from "@pragma/constants";
import { ChevronDown, ChevronRight } from "lucide-react";

import { ChangeFileList } from "@/components/right-sidebar/ChangeGroup";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { worktreeCommits } from "@/lib/tauri";

/** How many commits load initially and per "Load more" click. */
const COMMITS_PAGE_SIZE = 10;

type CommitsState =
  | { kind: "loading" }
  | { kind: "ready"; commits: WorktreeCommit[]; totalCount: number }
  | { kind: "error"; message: string };

/**
 * Loads the worktree's fork-point commits, `limit` at a time. Refetches when
 * the committed file list changes identity (the Changes poll keeps it stable
 * while nothing changed), so a new commit shows up without its own poll loop.
 */
function useWorktreeCommits(
  worktreeId: string,
  committedFiles: ChangedFile[],
): {
  state: CommitsState;
  hasMore: boolean;
  loadMore: () => void;
} {
  const [state, setState] = useState<CommitsState>({ kind: "loading" });
  const [limit, setLimit] = useState(COMMITS_PAGE_SIZE);
  // Drop in-flight responses for a previously selected worktree.
  const activeWorktree = useRef(worktreeId);

  useEffect(() => {
    setLimit(COMMITS_PAGE_SIZE);
    setState({ kind: "loading" });
  }, [worktreeId]);

  useEffect(() => {
    activeWorktree.current = worktreeId;
    let cancelled = false;
    void (async () => {
      try {
        const list = await worktreeCommits(worktreeId, limit);
        if (!cancelled && activeWorktree.current === worktreeId) {
          setState({ kind: "ready", commits: list.commits, totalCount: list.totalCount });
        }
      } catch (cause) {
        if (!cancelled && activeWorktree.current === worktreeId) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId, limit, committedFiles]);

  const loadMore = useCallback(() => setLimit((previous) => previous + COMMITS_PAGE_SIZE), []);
  const hasMore = state.kind === "ready" && state.totalCount > state.commits.length;
  return { state, hasMore, loadMore };
}

interface CommittedChangesGroupProps {
  worktreeId: string;
  /** The full committed (fork point → HEAD) file list. */
  files: ChangedFile[];
  /** Opens the unified worktree diff for a file in the "All changes" list. */
  onOpenFile: (file: ChangedFile) => void;
  /** Opens the single-commit diff for a file inside one commit's list. */
  onOpenCommitFile: (commit: WorktreeCommit, file: ChangedFile) => void;
}

/**
 * The "Committed changes" group: an "All changes" sub-collapsible with the
 * aggregate fork-point file list (what the group used to show directly),
 * followed by one collapsible row per commit — subject, short hash —
 * whose body lists that commit's files. Clicking a commit file opens a diff
 * scoped to that commit only. Commits page in batches of ten via "Load more".
 */
export function CommittedChangesGroup({
  worktreeId,
  files,
  onOpenFile,
  onOpenCommitFile,
}: CommittedChangesGroupProps) {
  const [open, setOpen] = useState(true);
  const { state, hasMore, loadMore } = useWorktreeCommits(worktreeId, files);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="group/header flex w-full items-center hover:bg-muted">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left text-xs text-muted-foreground">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">Committed changes</span>
        </CollapsibleTrigger>
        <span className="mr-2 shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {files.length}
        </span>
      </div>
      <CollapsibleContent>
        {files.length === 0 ? (
          <p className="px-4 py-1 text-[11px] text-muted-foreground">No committed changes</p>
        ) : (
          <>
            <SubCollapsible label="All changes">
              <ChangeFileList emptyLabel="No committed changes" files={files} onOpen={onOpenFile} />
            </SubCollapsible>
            <CommitRows onOpenCommitFile={onOpenCommitFile} state={state} />
            {hasMore && (
              <button
                className="mx-4 my-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={loadMore}
                type="button"
              >
                Load more
              </button>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The commit list body under "All changes": loading, error, or commit rows. */
function CommitRows({
  state,
  onOpenCommitFile,
}: {
  state: CommitsState;
  onOpenCommitFile: (commit: WorktreeCommit, file: ChangedFile) => void;
}) {
  if (state.kind === "loading") {
    return <p className="px-4 py-1 text-[11px] text-muted-foreground">Loading commits…</p>;
  }
  if (state.kind === "error") {
    return <p className="px-4 py-1 text-[11px] text-destructive">{state.message}</p>;
  }
  return state.commits.map((commit) => (
    <CommitRow commit={commit} key={commit.hash} onOpenCommitFile={onOpenCommitFile} />
  ));
}

/** One nested default-open collapsible ("All changes") inside the group. */
function SubCollapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1 px-3 py-1 text-left text-xs text-muted-foreground hover:bg-muted">
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One collapsible commit row, arranged like the GitHub PR timeline entry:
 * subject and short hash.
 * Expanding it lists the commit's files in the standard change-row style.
 */
function CommitRow({
  commit,
  onOpenCommitFile,
}: {
  commit: WorktreeCommit;
  onOpenCommitFile: (commit: WorktreeCommit, file: ChangedFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const openFile = useCallback(
    (file: ChangedFile) => onOpenCommitFile(commit, file),
    [commit, onOpenCommitFile],
  );
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted"
        title={commit.subject}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
        <span className="shrink-0 font-mono text-muted-foreground">{commit.shortHash}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ChangeFileList
          emptyLabel="No files in this commit"
          files={commit.files}
          onOpen={openFile}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
