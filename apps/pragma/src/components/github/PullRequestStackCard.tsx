import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { GitHubRepoRef, Worktree } from "@pragma/constants";
import { GitBranch, Layers3, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import {
  type PullRequestStack,
  type PullRequestStackEntry,
  type PullRequestSummary,
  createPullRequestStack,
  findPullRequestForBranch,
  getPullRequestStack,
} from "@/lib/github";
import { createWorktree, githubRepoRef } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { useWorkspace } from "@/state/workspace-context";

type WorkspaceApi = ReturnType<typeof useWorkspace>;

function worktreeLabel(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}

function ancestorChain(worktrees: Worktree[], currentId: string): Worktree[] {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const chain: Worktree[] = [];
  let current = byId.get(currentId);
  while (current && !current.isMain) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

/** Maps branch name → local worktrees for that branch, across the project. */
function indexByBranch(worktrees: Worktree[]): Map<string, Worktree[]> {
  const map = new Map<string, Worktree[]>();
  for (const worktree of worktrees) {
    const entries = map.get(worktree.branch) ?? [];
    entries.push(worktree);
    map.set(worktree.branch, entries);
  }
  return map;
}

/**
 * Loads GitHub's explicit stack object for a PR. When the PR is not stacked, the
 * local ancestor chain is scanned for candidate PRs to link into a new stack.
 */
function usePullRequestStack(
  repo: GitHubRepoRef,
  pr: PullRequestSummary,
  project: Worktree[],
  worktreeId: string,
): {
  stack: PullRequestStack | null | undefined;
  candidatePrs: PullRequestSummary[];
  loadError: string | null;
  setStack: Dispatch<SetStateAction<PullRequestStack | null | undefined>>;
} {
  const [stack, setStack] = useState<PullRequestStack | null | undefined>(undefined);
  const [candidatePrs, setCandidatePrs] = useState<PullRequestSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      try {
        const next = await getPullRequestStack(repo, pr.number, { force });
        setStack(next);
        setLoadError(null);
        if (!next) {
          const chain = ancestorChain(project, worktreeId);
          const summaries = await Promise.all(
            chain.map(async (worktree) => {
              const worktreeRepo = await githubRepoRef(worktree.id);
              if (worktreeRepo.owner !== repo.owner || worktreeRepo.repo !== repo.repo) return null;
              return findPullRequestForBranch(worktreeRepo);
            }),
          );
          setCandidatePrs(summaries.filter((entry): entry is PullRequestSummary => entry !== null));
        }
      } catch (cause) {
        setStack(null);
        setLoadError(errorMessage(cause));
      }
    },
    [pr.number, project, repo, worktreeId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { stack, candidatePrs, loadError, setStack };
}

/** Resolves the parent worktree a new stack layer should branch from, throwing when none exists. */
function resolveMissingParent(
  stack: PullRequestStack,
  index: number,
  localByBranch: Map<string, Worktree[]>,
  project: Worktree[],
): Worktree {
  const lowerEntries = stack.entries.slice(0, index).toReversed();
  const parent =
    lowerEntries.flatMap((entry) => localByBranch.get(entry.headRef) ?? []).at(0) ??
    project.find((worktree) => worktree.branch === stack.baseRef || worktree.isMain);
  if (!parent) throw new Error("No local trunk or lower stack worktree found");
  return parent;
}

/** Creates one missing stack worktree, branching from the resolved lower layer. */
async function createMissingWorktree(
  projectId: string,
  stack: PullRequestStack,
  index: number,
  branch: string,
  localByBranch: Map<string, Worktree[]>,
  project: Worktree[],
  workspace: WorkspaceApi,
): Promise<void> {
  const parent = resolveMissingParent(stack, index, localByBranch, project);
  const created = await createWorktree(projectId, parent.id, branch, undefined, branch);
  await workspace.refreshProject(projectId);
  workspace.selectWorktree(created.id, projectId);
}

/**
 * Creates every missing stack worktree bottom-to-top. Stack parentage requires
 * each checkout before the layer above it can be created.
 */
async function createAllMissingWorktrees(
  projectId: string,
  stack: PullRequestStack,
  localByBranch: Map<string, Worktree[]>,
  project: Worktree[],
  workspace: WorkspaceApi,
): Promise<{ parent: Worktree; createdCount: number }> {
  let parent = project.find((worktree) => worktree.branch === stack.baseRef || worktree.isMain);
  if (!parent) throw new Error("No local trunk worktree found");
  let createdCount = 0;
  for (const entry of stack.entries) {
    const local = (localByBranch.get(entry.headRef) ?? [])[0];
    if (local) {
      parent = local;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    parent = await createWorktree(projectId, parent.id, entry.headRef, undefined, entry.headRef);
    createdCount += 1;
  }
  await workspace.refreshProject(projectId);
  workspace.selectWorktree(parent.id, projectId);
  return { parent, createdCount };
}

/** Opens a terminal tab and kicks off the official `gh stack sync`. */
async function startStackSync(
  pr: PullRequestSummary,
  worktreeId: string,
  workspace: WorkspaceApi,
): Promise<void> {
  const tab = await workspace.createTerminalTab(worktreeId);
  if (!tab) throw new Error("Couldn't open a terminal for stack sync");
  terminalManager.writeWhenReady(tab.id, `gh stack checkout ${pr.number} && gh stack sync\r`);
}

interface PullRequestStackCardProps {
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  compact?: boolean;
}

/** Stack context, local-worktree links, stack linking, sync, and remote checkout actions. */
export function PullRequestStackCard({
  pr,
  repo,
  worktreeId,
  compact = false,
}: PullRequestStackCardProps) {
  const workspace = useWorkspace();
  const projectId = useMemo(
    () =>
      Object.entries(workspace.worktrees).find(([, worktrees]) =>
        worktrees.some((worktree) => worktree.id === worktreeId),
      )?.[0] ?? null,
    [workspace.worktrees, worktreeId],
  );
  const project = useMemo(
    () => workspace.worktrees[projectId ?? ""] ?? [],
    [projectId, workspace.worktrees],
  );
  const { stack, candidatePrs, loadError, setStack } = usePullRequestStack(
    repo,
    pr,
    project,
    worktreeId,
  );
  const localByBranch = useMemo(() => indexByBranch(project), [project]);
  const [busy, setBusy] = useState<string | null>(null);

  const link = useCallback(async () => {
    setBusy("link");
    try {
      const linked = await createPullRequestStack(
        repo,
        candidatePrs.map((entry) => entry.number),
      );
      setStack(linked);
      toast.success(`Created stack #${linked.number}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [candidatePrs, repo, setStack]);

  const createMissing = useCallback(
    async (branch: string, index: number) => {
      if (!projectId || !stack) return;
      setBusy(branch);
      try {
        await createMissingWorktree(
          projectId,
          stack,
          index,
          branch,
          localByBranch,
          project,
          workspace,
        );
        toast.success(`Created worktree for ${branch}`);
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [projectId, stack, localByBranch, project, workspace],
  );

  const createAllMissing = useCallback(async () => {
    if (!projectId || !stack) return;
    setBusy("all");
    try {
      const { createdCount } = await createAllMissingWorktrees(
        projectId,
        stack,
        localByBranch,
        project,
        workspace,
      );
      toast.success(`Created ${createdCount} stack worktree${createdCount === 1 ? "" : "s"}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [projectId, stack, localByBranch, project, workspace]);

  const sync = useCallback(async () => {
    setBusy("sync");
    try {
      await startStackSync(pr, worktreeId, workspace);
      toast.success("Started stack sync in terminal");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [pr, worktreeId, workspace]);

  if (stack === undefined) return null;
  if (loadError) return <StackLoadError error={loadError} />;
  if (!stack) {
    return (
      <CreateStackPrompt
        busy={busy}
        candidateCount={candidatePrs.length}
        onLink={() => void link()}
      />
    );
  }

  return (
    <StackSummary
      busy={busy}
      compact={compact}
      createAllMissing={() => void createAllMissing()}
      createMissing={(branch, index) => void createMissing(branch, index)}
      localByBranch={localByBranch}
      onSelectWorktree={(id, pid) => workspace.selectWorktree(id, pid)}
      prNumber={pr.number}
      stack={stack}
      sync={() => void sync()}
    />
  );
}

function StackLoadError({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      Couldn&apos;t load stack: {error}
    </div>
  );
}

/** The "link local ancestor PRs into a stack" prompt shown for an unstacked PR. */
function CreateStackPrompt({
  busy,
  candidateCount,
  onLink,
}: {
  busy: string | null;
  candidateCount: number;
  onLink: () => void;
}) {
  if (candidateCount < 2) return null;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-canvas px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Layers3 className="size-3.5" /> {candidateCount} dependent PRs
      </span>
      <Button disabled={busy !== null} onClick={onLink} size="xs" variant="outline">
        {busy === "link" ? <Loader2 className="animate-spin" /> : null}
        Create stack
      </Button>
    </div>
  );
}

/** One stack layer: PR number, a link to its local worktree, or a create-worktree action. */
function StackEntryRow({
  busy,
  entry,
  index,
  localByBranch,
  onCreateMissing,
  onSelectWorktree,
  prNumber,
}: {
  busy: string | null;
  entry: PullRequestStackEntry;
  index: number;
  localByBranch: Map<string, Worktree[]>;
  onCreateMissing: (branch: string, index: number) => void;
  onSelectWorktree: (id: string, projectId: string) => void;
  prNumber: number;
}) {
  const matches = localByBranch.get(entry.headRef) ?? [];
  const local = matches.length === 1 ? matches[0] : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={
          entry.number === prNumber ? "font-semibold text-foreground" : "text-muted-foreground"
        }
      >
        #{entry.number} {entry.headRef}
      </span>
      {local ? (
        <button
          className="ml-auto flex items-center gap-1 truncate text-primary hover:underline"
          onClick={() => onSelectWorktree(local.id, local.projectId)}
          type="button"
        >
          <GitBranch className="size-3" /> {worktreeLabel(local)}
        </button>
      ) : matches.length > 1 ? (
        <span className="ml-auto text-warning">Ambiguous local branch</span>
      ) : (
        <Button
          className="ml-auto"
          disabled={busy !== null}
          onClick={() => onCreateMissing(entry.headRef, index)}
          size="xs"
          variant="ghost"
        >
          {busy === entry.headRef ? <Loader2 className="animate-spin" /> : null}
          Create worktree
        </Button>
      )}
    </div>
  );
}

/** The full stack card: header (position + actions) and the bottom-to-top layer list. */
function StackSummary({
  busy,
  compact,
  createAllMissing,
  createMissing,
  localByBranch,
  onSelectWorktree,
  prNumber,
  stack,
  sync,
}: {
  busy: string | null;
  compact: boolean;
  createAllMissing: () => void;
  createMissing: (branch: string, index: number) => void;
  localByBranch: Map<string, Worktree[]>;
  onSelectWorktree: (id: string, projectId: string) => void;
  prNumber: number;
  stack: PullRequestStack;
  sync: () => void;
}) {
  const position = stack.entries.findIndex((entry) => entry.number === prNumber) + 1;
  const missingCount = stack.entries.filter(
    (entry) => (localByBranch.get(entry.headRef) ?? []).length === 0,
  ).length;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-canvas p-3 text-xs">
      <div className="flex items-center gap-2">
        <Layers3 className="size-4 text-primary" />
        <strong className="text-foreground">
          Stack {position} of {stack.entries.length}
        </strong>
        {!compact ? (
          <div className="ml-auto flex gap-1">
            {missingCount > 1 ? (
              <Button
                disabled={busy !== null}
                onClick={createAllMissing}
                size="xs"
                variant="outline"
              >
                {busy === "all" ? <Loader2 className="animate-spin" /> : null}
                Create all missing
              </Button>
            ) : null}
            <Button disabled={busy !== null} onClick={sync} size="xs" variant="outline">
              {busy === "sync" ? <Loader2 className="animate-spin" /> : null}
              Sync stack
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-1 border-l border-border pl-2">
        {stack.entries.map((entry, index) => (
          <StackEntryRow
            busy={busy}
            entry={entry}
            index={index}
            key={entry.number}
            localByBranch={localByBranch}
            onCreateMissing={createMissing}
            onSelectWorktree={onSelectWorktree}
            prNumber={prNumber}
          />
        ))}
        <span className="text-muted-foreground">trunk · {stack.baseRef}</span>
      </div>
    </div>
  );
}
