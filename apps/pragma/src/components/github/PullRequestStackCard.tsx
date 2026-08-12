import { useCallback, useEffect, useMemo, useState } from "react";

import type { GitHubRepoRef, Worktree } from "@pragma/constants";
import { GitBranch, Layers3, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import {
  type PullRequestStack,
  type PullRequestSummary,
  createPullRequestStack,
  findPullRequestForBranch,
  getPullRequestStack,
} from "@/lib/github";
import { createWorktree, githubRepoRef } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { useWorkspace } from "@/state/workspace-context";

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

/** Stack context, local-worktree links, stack linking, sync, and remote checkout actions. */
export function PullRequestStackCard({
  pr,
  repo,
  worktreeId,
  compact = false,
}: {
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  compact?: boolean;
}) {
  const workspace = useWorkspace();
  const [stack, setStack] = useState<PullRequestStack | null | undefined>(undefined);
  const [candidatePrs, setCandidatePrs] = useState<PullRequestSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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

  const localByBranch = useMemo(() => {
    const map = new Map<string, Worktree[]>();
    for (const worktree of project) {
      const entries = map.get(worktree.branch) ?? [];
      entries.push(worktree);
      map.set(worktree.branch, entries);
    }
    return map;
  }, [project]);

  const link = async () => {
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
  };

  const createMissing = async (branch: string, index: number) => {
    if (!projectId || !stack) return;
    setBusy(branch);
    try {
      const lowerEntries = stack.entries.slice(0, index).toReversed();
      const parent =
        lowerEntries.flatMap((entry) => localByBranch.get(entry.headRef) ?? []).at(0) ??
        project.find((worktree) => worktree.branch === stack.baseRef || worktree.isMain);
      if (!parent) throw new Error("No local trunk or lower stack worktree found");
      const created = await createWorktree(projectId, parent.id, branch, undefined, branch);
      await workspace.refreshProject(projectId);
      workspace.selectWorktree(created.id, projectId);
      toast.success(`Created worktree for ${branch}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const createAllMissing = async () => {
    if (!projectId || !stack) return;
    setBusy("all");
    try {
      let parent = project.find((worktree) => worktree.branch === stack.baseRef || worktree.isMain);
      if (!parent) throw new Error("No local trunk worktree found");
      let createdCount = 0;
      // Stack parentage requires each checkout before creating layer above it.
      for (const entry of stack.entries) {
        const local = (localByBranch.get(entry.headRef) ?? [])[0];
        if (local) {
          parent = local;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        parent = await createWorktree(
          projectId,
          parent.id,
          entry.headRef,
          undefined,
          entry.headRef,
        );
        createdCount += 1;
      }
      await workspace.refreshProject(projectId);
      workspace.selectWorktree(parent.id, projectId);
      toast.success(`Created ${createdCount} stack worktree${createdCount === 1 ? "" : "s"}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    try {
      const tab = await workspace.createTerminalTab(worktreeId);
      if (!tab) throw new Error("Couldn't open a terminal for stack sync");
      terminalManager.writeWhenReady(tab.id, `gh stack checkout ${pr.number} && gh stack sync\r`);
      toast.success("Started stack sync in terminal");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (stack === undefined) return null;
  if (loadError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Couldn&apos;t load stack: {loadError}
      </div>
    );
  }
  if (!stack) {
    if (candidatePrs.length < 2) return null;
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-canvas px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Layers3 className="size-3.5" /> {candidatePrs.length} dependent PRs
        </span>
        <Button disabled={busy !== null} onClick={() => void link()} size="xs" variant="outline">
          {busy === "link" ? <Loader2 className="animate-spin" /> : null}
          Create stack
        </Button>
      </div>
    );
  }

  const position = stack.entries.findIndex((entry) => entry.number === pr.number) + 1;
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
                onClick={() => void createAllMissing()}
                size="xs"
                variant="outline"
              >
                {busy === "all" ? <Loader2 className="animate-spin" /> : null}
                Create all missing
              </Button>
            ) : null}
            <Button
              disabled={busy !== null}
              onClick={() => void sync()}
              size="xs"
              variant="outline"
            >
              {busy === "sync" ? <Loader2 className="animate-spin" /> : null}
              Sync stack
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-1 border-l border-border pl-2">
        {stack.entries.map((entry, index) => {
          const matches = localByBranch.get(entry.headRef) ?? [];
          const local = matches.length === 1 ? matches[0] : null;
          return (
            <div className="flex min-w-0 items-center gap-2" key={entry.number}>
              <span
                className={
                  entry.number === pr.number
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground"
                }
              >
                #{entry.number} {entry.headRef}
              </span>
              {local ? (
                <button
                  className="ml-auto flex items-center gap-1 truncate text-primary hover:underline"
                  onClick={() => workspace.selectWorktree(local.id, local.projectId)}
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
                  onClick={() => void createMissing(entry.headRef, index)}
                  size="xs"
                  variant="ghost"
                >
                  {busy === entry.headRef ? <Loader2 className="animate-spin" /> : null}
                  Create worktree
                </Button>
              )}
            </div>
          );
        })}
        <span className="text-muted-foreground">trunk · {stack.baseRef}</span>
      </div>
    </div>
  );
}
