import { useCallback, useEffect, useRef, useState } from "react";

import type { BranchSyncStatus, GitHubRepoRef } from "@pragma/constants";
import { ArrowLeft, ChevronDown, GitPullRequestCreate, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import {
  createPullRequest,
  listBaseRepoOptions,
  listBranches,
  type PullRequestSummary,
  type RepoTarget,
} from "@/lib/github";
import {
  type AiPullRequestDraft,
  aiGeneratePullRequestDraft,
  githubDefaultPrTitle,
  githubFetchAndSync,
  githubPushBranch,
  worktreeChanges,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A submit blocked or waiting on confirmation by the pre-flight checks. The dirty
 * variant carries the already-fetched {@link BranchSyncStatus} so confirming past
 * the warning doesn't re-run `github_fetch_and_sync`.
 */
type Preflight =
  | { kind: "behind"; behind: number }
  | { kind: "dirty"; draft: boolean; sync: BranchSyncStatus }
  | null;

/**
 * The create-PR form: a title (seeded with the branch's last commit subject), a
 * markdown body editor, and primary **Create pull request** / secondary **Create
 * draft** actions.
 *
 * On submit it runs the pre-flight in {@link CreatePullRequestView}: `github_fetch_and_sync`
 * first — if the branch is **behind** its upstream the submit is **blocked** (pull
 * / rebase first); uncommitted staged/unstaged changes only **warn** (they won't
 * be part of the PR). When the branch has no upstream it is pushed first, then the
 * PR is opened and the parent switches straight to the view state with the
 * created PR (the open-PR list is eventually consistent, so we hand the PR up
 * directly instead of re-resolving and risking a transient "not found").
 */
export function CreatePullRequestView({
  initialDraft,
  initialDraftKey,
  repo,
  worktreeId,
  onCreated,
}: {
  initialDraft?: AiPullRequestDraft | null;
  initialDraftKey?: number;
  repo: GitHubRepoRef;
  worktreeId: string;
  onCreated: (pr: PullRequestSummary) => void;
}) {
  const { available: aiAvailable } = useAi();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preflight, setPreflight] = useState<Preflight>(null);

  // The merge-into target: which repository (origin, or its upstream parent for a
  // fork) and which branch the PR opens against. The base branch defaults to the
  // parent worktree's branch — what this worktree was created to merge back into.
  const [baseRepos, setBaseRepos] = useState<RepoTarget[]>([]);
  const [baseRepo, setBaseRepo] = useState<RepoTarget | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  // Bumped on every base-repo switch so a slow `listBranches` for a now-stale
  // repo can't clobber the current selection.
  const branchToken = useRef(0);

  useEffect(() => {
    if (!initialDraft) {
      return;
    }
    setTitle(initialDraft.title);
    setBody(initialDraft.body);
  }, [initialDraft, initialDraftKey]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const subject = await githubDefaultPrTitle(worktreeId);
        if (active && subject) {
          setTitle((current) => current || subject);
        }
      } catch {
        // A missing default title is non-fatal — the user types one.
      }
    })();
    return () => {
      active = false;
    };
  }, [worktreeId]);

  // Loads a base repo's branches and selects an initial branch: the parent
  // worktree branch when that repo is `origin` and the branch exists there,
  // otherwise the repo's default branch.
  const selectBaseRepo = useCallback(
    async (target: RepoTarget) => {
      setBaseRepo(target);
      setBranches([]);
      setBaseBranch(null);
      const token = ++branchToken.current;
      try {
        const names = await listBranches(target);
        if (token !== branchToken.current) {
          return;
        }
        const preferred =
          !target.isUpstream && repo.parentBranch && names.includes(repo.parentBranch)
            ? repo.parentBranch
            : target.defaultBranch;
        setBranches(names);
        setBaseBranch(preferred);
      } catch (cause) {
        if (token === branchToken.current) {
          toast.error(messageFor(cause));
        }
      }
    },
    [repo.parentBranch],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const options = await listBaseRepoOptions(repo);
        if (!active) {
          return;
        }
        setBaseRepos(options);
        // Default to the origin repo (options[0]) so the parent-worktree branch
        // is the suggested base; the user can switch to an upstream fork.
        const initial = options[0];
        if (initial) {
          await selectBaseRepo(initial);
        }
      } catch (cause) {
        if (active) {
          toast.error(messageFor(cause));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [repo, selectBaseRepo]);

  // Opens the PR after the pre-flight has passed (or the user confirmed past a
  // dirty-tree warning). Reuses the pre-flight's `sync` result instead of
  // re-fetching, and pushes the branch first when it has no upstream.
  const open = useCallback(
    async (draft: boolean, sync: BranchSyncStatus) => {
      if (!baseRepo || !baseBranch) {
        return;
      }
      setSubmitting(true);
      try {
        if (!sync.hasUpstream) {
          await githubPushBranch(worktreeId);
        }
        const pr = await createPullRequest(
          repo,
          { owner: baseRepo.owner, repo: baseRepo.repo, branch: baseBranch },
          { title: title.trim(), body, draft },
        );
        toast.success(`Opened pull request #${pr.number}`);
        onCreated(pr);
      } catch (cause) {
        toast.error(messageFor(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [repo, worktreeId, title, body, onCreated, baseRepo, baseBranch],
  );

  // Runs the gating pre-flight before opening: blocks when behind, warns when the
  // worktree is dirty, otherwise opens straight away.
  const submit = useCallback(
    async (draft: boolean) => {
      if (submitting || !title.trim()) {
        return;
      }
      setSubmitting(true);
      let sync: BranchSyncStatus;
      try {
        const [synced, changes] = await Promise.all([
          githubFetchAndSync(worktreeId),
          worktreeChanges(worktreeId),
        ]);
        sync = synced;
        if (sync.behind > 0) {
          setPreflight({ kind: "behind", behind: sync.behind });
          return;
        }
        if (changes.staged.length > 0 || changes.unstaged.length > 0) {
          setPreflight({ kind: "dirty", draft, sync });
          return;
        }
      } catch (cause) {
        toast.error(messageFor(cause));
        return;
      } finally {
        setSubmitting(false);
      }
      await open(draft, sync);
    },
    [submitting, title, worktreeId, open],
  );

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    !generating &&
    baseRepo !== null &&
    baseBranch !== null;
  const generateDraft = useCallback(async () => {
    if (!aiAvailable || generating || !worktreeId) {
      return;
    }
    setGenerating(true);
    try {
      const draft = await aiGeneratePullRequestDraft(worktreeId);
      setTitle(draft.title);
      setBody(draft.body);
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setGenerating(false);
    }
  }, [aiAvailable, generating, worktreeId]);
  const handleGenerateShortcut = useCallback(
    (event: { shiftKey: boolean; key: string; preventDefault: () => void }) => {
      if (aiAvailable && event.shiftKey && event.key === "Tab") {
        event.preventDefault();
        void generateDraft();
      }
    },
    [aiAvailable, generateDraft],
  );
  const multipleRepos = baseRepos.length > 1;
  // The head ref, qualified with the origin owner when targeting a different repo
  // (a cross-fork PR), matching GitHub's `owner:branch` head display.
  const headLabel =
    baseRepo && baseRepo.owner !== repo.owner
      ? `${repo.owner}:${repo.headBranch}`
      : repo.headBranch;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">Create pull request</p>
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
        {multipleRepos ? (
          <Select
            onValueChange={(value) => {
              const target = baseRepos.find((option) => `${option.owner}/${option.repo}` === value);
              if (target) {
                void selectBaseRepo(target);
              }
            }}
            value={baseRepo ? `${baseRepo.owner}/${baseRepo.repo}` : undefined}
          >
            <SelectTrigger
              aria-label="Base repository"
              className="h-7 min-w-0 flex-1 font-mono text-[11px]"
              size="sm"
            >
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              {baseRepos.map((target) => (
                <SelectItem
                  className="font-mono text-[11px]"
                  key={`${target.owner}/${target.repo}`}
                  value={`${target.owner}/${target.repo}`}
                >
                  {target.owner}/{target.repo}
                  {target.isUpstream ? (
                    <span className="ml-1 text-slate-500">(upstream)</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          disabled={branches.length === 0}
          onValueChange={setBaseBranch}
          value={baseBranch ?? undefined}
        >
          <SelectTrigger
            aria-label="Base branch"
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            size="sm"
          >
            <SelectValue placeholder="Loading…" />
          </SelectTrigger>
          <SelectContent>
            {branches.map((name) => (
              <SelectItem className="font-mono text-[11px]" key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ArrowLeft className="size-3 shrink-0 text-slate-600" />
        <span className="min-w-0 flex-1 truncate rounded bg-white/5 px-1.5 py-0.5 font-mono text-slate-300">
          {headLabel}
        </span>
      </div>
      <Input
        aria-label="Pull request title"
        autoCapitalize="none"
        disabled={generating}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={handleGenerateShortcut}
        placeholder={aiAvailable ? "Shift + tab to generate" : "Title"}
        spellCheck="true"
        value={title}
      />
      <MarkdownEditor
        onChange={setBody}
        onKeyDown={handleGenerateShortcut}
        placeholder={
          generating
            ? "Generating pull request…"
            : aiAvailable
              ? "Shift + tab to generate"
              : "Describe your changes…"
        }
        value={body}
      />
      <div className="flex items-center">
        <Button
          className="rounded-r-none"
          disabled={!canSubmit}
          onClick={() => void submit(false)}
          size="sm"
        >
          {submitting ? <Loader2 className="animate-spin" /> : <GitPullRequestCreate />}
          Create pull request
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="More create options"
              className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
              disabled={!canSubmit}
              size="sm"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void submit(false)}>
              Create pull request
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void submit(true)}>Create draft</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog onOpenChange={(open_) => !open_ && setPreflight(null)} open={preflight !== null}>
        <AlertDialogContent>
          {preflight?.kind === "behind" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Branch is behind</AlertDialogTitle>
                <AlertDialogDescription>
                  {repo.headBranch} is {preflight.behind} commit
                  {preflight.behind === 1 ? "" : "s"} behind its upstream. Pull or rebase before
                  opening a pull request.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>OK</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Uncommitted changes</AlertDialogTitle>
                <AlertDialogDescription>
                  This worktree has uncommitted changes that won&apos;t be part of the pull request.
                  Create it anyway?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const confirmed = preflight?.kind === "dirty" ? preflight : null;
                    setPreflight(null);
                    if (confirmed) {
                      void open(confirmed.draft, confirmed.sync);
                    }
                  }}
                >
                  Create anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
