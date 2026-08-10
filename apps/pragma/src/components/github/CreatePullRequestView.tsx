import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

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

const PR_DRAFT_STORAGE_PREFIX = "pragma:pull-request-draft:";

type PullRequestDraft = { title: string; body: string };

/** Reads a worktree's unfinished PR form, ignoring unavailable or malformed storage. */
function readPullRequestDraft(worktreeId: string): PullRequestDraft {
  try {
    const raw = window.localStorage.getItem(`${PR_DRAFT_STORAGE_PREFIX}${worktreeId}`);
    if (!raw) return { title: "", body: "" };
    const parsed = JSON.parse(raw) as Partial<PullRequestDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return { title: "", body: "" };
  }
}

/** Persists unfinished PR form content outside git so commits cannot reset it. */
function savePullRequestDraft(worktreeId: string, draft: PullRequestDraft): void {
  try {
    const key = `${PR_DRAFT_STORAGE_PREFIX}${worktreeId}`;
    if (!draft.title && !draft.body) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Draft persistence must not prevent editing when localStorage is unavailable.
  }
}

/** Removes a worktree's saved form after its PR has been opened successfully. */
function clearPullRequestDraft(worktreeId: string): void {
  try {
    window.localStorage.removeItem(`${PR_DRAFT_STORAGE_PREFIX}${worktreeId}`);
  } catch {
    // The PR is open even if the best-effort draft cleanup cannot run.
  }
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

/** The head ref, qualified with the origin owner for a cross-fork PR. */
function buildHeadLabel(baseRepo: RepoTarget | null, repo: GitHubRepoRef): string {
  if (baseRepo && baseRepo.owner !== repo.owner) {
    return `${repo.owner}:${repo.headBranch}`;
  }
  return repo.headBranch;
}

/** Markdown body placeholder for the current AI/generating state. */
function bodyPlaceholder(generating: boolean, aiAvailable: boolean): string {
  if (generating) return "Generating pull request…";
  return aiAvailable ? "Shift + tab to generate" : "Describe your changes…";
}

/** Seed the title/body from an AI-supplied draft when it arrives. */
function usePrInitialDraft(
  initialDraft: AiPullRequestDraft | null | undefined,
  initialDraftKey: number | undefined,
  setTitle: (title: string) => void,
  setBody: (body: string) => void,
): void {
  useEffect(() => {
    if (!initialDraft) return;
    setTitle(initialDraft.title);
    setBody(initialDraft.body);
  }, [initialDraft, initialDraftKey, setTitle, setBody]);
}

/** Default the title to the branch's last commit subject (non-fatal if missing). */
function usePrTitleDefault(
  worktreeId: string,
  setTitle: (updater: (current: string) => string) => void,
): void {
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const subject = await githubDefaultPrTitle(worktreeId);
        if (active && subject) setTitle((current) => current || subject);
      } catch {
        // A missing default title is non-fatal — the user types one.
      }
    })();
    return () => {
      active = false;
    };
  }, [worktreeId, setTitle]);
}

/** Loads a base repo's branches and selects an initial branch (token-guarded). */
function useBaseRepoSelection(repo: GitHubRepoRef): {
  baseRepos: RepoTarget[];
  baseRepo: RepoTarget | null;
  branches: string[];
  baseBranch: string | null;
  setBaseBranch: (branch: string | null) => void;
  selectBaseRepo: (target: RepoTarget) => Promise<void>;
} {
  const [baseRepos, setBaseRepos] = useState<RepoTarget[]>([]);
  const [baseRepo, setBaseRepo] = useState<RepoTarget | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  // Bumped on every base-repo switch so a slow `listBranches` for a now-stale
  // repo can't clobber the current selection.
  const branchToken = useRef(0);

  const selectBaseRepo = useCallback(
    async (target: RepoTarget) => {
      setBaseRepo(target);
      setBranches([]);
      setBaseBranch(null);
      const token = ++branchToken.current;
      try {
        const names = await listBranches(target);
        if (token !== branchToken.current) return;
        const preferred =
          !target.isUpstream && repo.parentBranch && names.includes(repo.parentBranch)
            ? repo.parentBranch
            : target.defaultBranch;
        setBranches(names);
        setBaseBranch(preferred);
      } catch (cause) {
        if (token === branchToken.current) toast.error(errorMessage(cause));
      }
    },
    [repo.parentBranch],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const options = await listBaseRepoOptions(repo);
        if (!active) return;
        setBaseRepos(options);
        // Default to the origin repo (options[0]) so the parent-worktree branch
        // is the suggested base; the user can switch to an upstream fork.
        const initial = options[0];
        if (initial) await selectBaseRepo(initial);
      } catch (cause) {
        if (active) toast.error(errorMessage(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [repo, selectBaseRepo]);

  return { baseRepos, baseRepo, branches, baseBranch, setBaseBranch, selectBaseRepo };
}

/** Pre-flight gating + the final PR open after the checks pass or are confirmed. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePaletteAsyncData, useWorkspaceListeners, ProjectScriptButton, TerminalTabItem); not extractable logic.
function usePrSubmit({
  repo,
  worktreeId,
  title,
  body,
  onCreated,
  baseRepo,
  baseBranch,
}: {
  repo: GitHubRepoRef;
  worktreeId: string;
  title: string;
  body: string;
  onCreated: (pr: PullRequestSummary) => void;
  baseRepo: RepoTarget | null;
  baseBranch: string | null;
}): {
  submitting: boolean;
  preflight: Preflight;
  setPreflight: (preflight: Preflight) => void;
  open: (draft: boolean, sync: BranchSyncStatus) => Promise<void>;
  submit: (draft: boolean) => Promise<void>;
} {
  const [submitting, setSubmitting] = useState(false);
  const [preflight, setPreflight] = useState<Preflight>(null);

  const open = useCallback(
    async (draft: boolean, sync: BranchSyncStatus) => {
      if (!baseRepo || !baseBranch) return;
      setSubmitting(true);
      try {
        if (!sync.hasUpstream) await githubPushBranch(worktreeId);
        const pr = await createPullRequest(
          repo,
          { owner: baseRepo.owner, repo: baseRepo.repo, branch: baseBranch },
          { title: title.trim(), body, draft, worktreeId },
        );
        toast.success(`Opened pull request #${pr.number}`);
        clearPullRequestDraft(worktreeId);
        onCreated(pr);
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSubmitting(false);
      }
    },
    [repo, worktreeId, title, body, onCreated, baseRepo, baseBranch],
  );

  const submit = useCallback(
    async (draft: boolean) => {
      if (submitting || !title.trim()) return;
      setSubmitting(true);
      let sync: BranchSyncStatus;
      try {
        const [synced, changes] = await Promise.all([
          githubFetchAndSync(worktreeId),
          worktreeChanges(worktreeId),
        ]);
        sync = synced;
        if (sync.hasUpstream && sync.behind > 0) {
          setPreflight({ kind: "behind", behind: sync.behind });
          return;
        }
        if (changes.staged.length > 0 || changes.unstaged.length > 0) {
          setPreflight({ kind: "dirty", draft, sync });
          return;
        }
      } catch (cause) {
        toast.error(errorMessage(cause));
        return;
      } finally {
        setSubmitting(false);
      }
      await open(draft, sync);
    },
    [submitting, title, worktreeId, open],
  );

  return { submitting, preflight, setPreflight, open, submit };
}

/** AI draft generation + the Shift+Tab shortcut that triggers it. */
function usePrGenerateDraft(
  aiAvailable: boolean,
  worktreeId: string,
  setTitle: (title: string) => void,
  setBody: (body: string) => void,
): {
  generating: boolean;
  handleGenerateShortcut: (event: {
    shiftKey: boolean;
    key: string;
    preventDefault: () => void;
  }) => void;
} {
  const [generating, setGenerating] = useState(false);
  const generateDraft = useCallback(async () => {
    if (!aiAvailable || generating || !worktreeId) return;
    setGenerating(true);
    try {
      const draft = await aiGeneratePullRequestDraft(worktreeId);
      setTitle(draft.title);
      setBody(draft.body);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setGenerating(false);
    }
  }, [aiAvailable, generating, worktreeId, setTitle, setBody]);
  const handleGenerateShortcut = useCallback(
    (event: { shiftKey: boolean; key: string; preventDefault: () => void }) => {
      if (aiAvailable && event.shiftKey && event.key === "Tab") {
        event.preventDefault();
        void generateDraft();
      }
    },
    [aiAvailable, generateDraft],
  );
  return { generating, handleGenerateShortcut };
}

/** What the view needs to open a PR — the same inputs its form hook takes. */
interface CreatePullRequestProps {
  initialDraft?: AiPullRequestDraft | null;
  initialDraftKey?: number;
  repo: GitHubRepoRef;
  worktreeId: string;
  onCreated: (pr: PullRequestSummary) => void;
}

/** Owns the create-PR form state and handlers. */
function useCreatePullRequestForm({
  initialDraft,
  initialDraftKey,
  repo,
  worktreeId,
  onCreated,
}: CreatePullRequestProps) {
  const { available: aiAvailable } = useAi();
  const [title, setTitle] = useState(() => readPullRequestDraft(worktreeId).title);
  const [body, setBody] = useState(() => readPullRequestDraft(worktreeId).body);
  const { baseRepos, baseRepo, branches, baseBranch, setBaseBranch, selectBaseRepo } =
    useBaseRepoSelection(repo);
  const { submitting, preflight, setPreflight, open, submit } = usePrSubmit({
    repo,
    worktreeId,
    title,
    body,
    onCreated,
    baseRepo,
    baseBranch,
  });
  const { generating, handleGenerateShortcut } = usePrGenerateDraft(
    aiAvailable,
    worktreeId,
    setTitle,
    setBody,
  );

  usePrInitialDraft(initialDraft, initialDraftKey, setTitle, setBody);
  usePrTitleDefault(worktreeId, setTitle);

  useEffect(() => {
    savePullRequestDraft(worktreeId, { title, body });
  }, [worktreeId, title, body]);

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    !generating &&
    baseRepo !== null &&
    baseBranch !== null;
  const multipleRepos = baseRepos.length > 1;
  const headLabel = buildHeadLabel(baseRepo, repo);
  const onCreatePr = useCallback(() => void submit(false), [submit]);
  const onCreateDraft = useCallback(() => void submit(true), [submit]);

  return {
    aiAvailable,
    title,
    setTitle,
    body,
    setBody,
    submitting,
    generating,
    preflight,
    setPreflight,
    baseRepos,
    baseRepo,
    branches,
    baseBranch,
    setBaseBranch,
    selectBaseRepo,
    open,
    onCreatePr,
    onCreateDraft,
    handleGenerateShortcut,
    canSubmit,
    multipleRepos,
    headLabel,
  };
}

/** Dropdown that picks which repository the PR targets (origin or upstream fork). */
function BaseRepoSelect({
  baseRepos,
  baseRepo,
  onSelect,
}: {
  baseRepos: RepoTarget[];
  baseRepo: RepoTarget | null;
  onSelect: (target: RepoTarget) => void;
}) {
  const handleValueChange = useCallback(
    (value: string) => {
      const target = baseRepos.find((option) => `${option.owner}/${option.repo}` === value);
      if (target) onSelect(target);
    },
    [baseRepos, onSelect],
  );
  return (
    <Select
      onValueChange={handleValueChange}
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
              <span className="ml-1 text-muted-foreground">(upstream)</span>
            ) : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Dropdown that picks the base branch within the selected repository. */
function BaseBranchSelect({
  branches,
  baseBranch,
  onSelect,
}: {
  branches: string[];
  baseBranch: string | null;
  onSelect: (branch: string) => void;
}) {
  return (
    <Select
      disabled={branches.length === 0}
      onValueChange={onSelect}
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
  );
}

/** Pluralize "commit"/"commits" for the behind-count message. */
function behindWord(count: number): string {
  return count === 1 ? "commit" : "commits";
}

/** Confirmation/error dialog surfaced by the pre-flight checks. */
function PreflightDialog({
  preflight,
  repo,
  onClose,
  onConfirmDirty,
}: {
  preflight: Preflight;
  repo: GitHubRepoRef;
  onClose: () => void;
  onConfirmDirty: (draft: boolean, sync: BranchSyncStatus) => void;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const handleConfirm = useCallback(() => {
    if (preflight?.kind === "dirty") {
      onConfirmDirty(preflight.draft, preflight.sync);
    }
  }, [preflight, onConfirmDirty]);
  if (preflight?.kind === "behind") {
    return (
      <AlertDialog onOpenChange={handleOpenChange} open={preflight !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Branch is behind</AlertDialogTitle>
            <AlertDialogDescription>
              {repo.headBranch} is {preflight.behind} {behindWord(preflight.behind)} behind its
              upstream. Pull or rebase before opening a pull request.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>OK</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <AlertDialog onOpenChange={handleOpenChange} open={preflight !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uncommitted changes</AlertDialogTitle>
          <AlertDialogDescription>
            This worktree has uncommitted changes that won&apos;t be part of the pull request.
            Create it anyway?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Create anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The create-PR form: a title (seeded with the branch's last commit subject), a
 * markdown body editor, and primary **Create pull request** / secondary **Create
 * draft** actions.
 *
 * On submit it runs the pre-flight: `github_fetch_and_sync` first — if the branch
 * is **behind** its upstream the submit is **blocked** (pull / rebase first);
 * uncommitted staged/unstaged changes only **warn** (they won't be part of the
 * PR). When the branch has no upstream it is pushed first, then the PR is opened
 * and the parent switches straight to the view state with the created PR (the
 * open-PR list is eventually consistent, so we hand the PR up directly instead of
 * re-resolving and risking a transient "not found").
 */
export function CreatePullRequestView({
  initialDraft,
  initialDraftKey,
  repo,
  worktreeId,
  onCreated,
}: CreatePullRequestProps) {
  const form = useCreatePullRequestForm({
    initialDraft,
    initialDraftKey,
    repo,
    worktreeId,
    onCreated,
  });
  const closePreflight = useCallback(() => form.setPreflight(null), [form]);
  const confirmDirty = useCallback(
    (draft: boolean, sync: BranchSyncStatus) => void form.open(draft, sync),
    [form],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Create pull request
      </p>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {form.multipleRepos ? (
          <BaseRepoSelect
            baseRepo={form.baseRepo}
            baseRepos={form.baseRepos}
            onSelect={form.selectBaseRepo}
          />
        ) : null}
        <BaseBranchSelect
          baseBranch={form.baseBranch}
          branches={form.branches}
          onSelect={form.setBaseBranch}
        />
        <ArrowLeft className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
          {form.headLabel}
        </span>
      </div>
      <Input
        aria-label="Pull request title"
        autoCapitalize="none"
        disabled={form.generating}
        onChange={(event) => form.setTitle(event.target.value)}
        onKeyDown={form.handleGenerateShortcut}
        placeholder={form.aiAvailable ? "Shift + tab to generate" : "Title"}
        spellCheck="true"
        value={form.title}
      />
      <MarkdownEditor
        onChange={form.setBody}
        onKeyDown={form.handleGenerateShortcut}
        placeholder={bodyPlaceholder(form.generating, form.aiAvailable)}
        value={form.body}
      />
      <div className="flex items-center">
        <Button
          className="rounded-r-none"
          disabled={!form.canSubmit}
          onClick={form.onCreatePr}
          size="sm"
        >
          {form.submitting ? <Loader2 className="animate-spin" /> : <GitPullRequestCreate />}
          Create pull request
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="More create options"
              className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
              disabled={!form.canSubmit}
              size="sm"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={form.onCreatePr}>Create pull request</DropdownMenuItem>
            <DropdownMenuItem onClick={form.onCreateDraft}>Create draft</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <PreflightDialog
        onClose={closePreflight}
        onConfirmDirty={confirmDirty}
        preflight={form.preflight}
        repo={repo}
      />
    </div>
  );
}
