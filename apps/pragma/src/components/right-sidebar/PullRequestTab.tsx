import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { GitHubRepoRef } from "@pragma/constants";

import { CreatePullRequestView } from "@/components/github/CreatePullRequestView";
import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { ViewPullRequestView } from "@/components/github/ViewPullRequestView";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { findPullRequestForBranch, getPullRequest, type PullRequestSummary } from "@/lib/github";
import { type AiPullRequestDraft, githubRepoRef } from "@/lib/tauri";
import { useGitHub } from "@/state/github-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * How often the Pull Request subtab re-resolves its state while mounted. GitHub
 * has no push channel here, so we poll like `ChangesTab` — but at a slower beat,
 * since each refresh is a remote API round-trip subject to rate limits and PR
 * state changes far less often than the working tree. Cached responses make
 * each tick cheap when nothing changed.
 */
const PR_REFRESH_INTERVAL_MS = 10_000;

/**
 * The Pull Request subtab controller. Resolves, in order:
 * - **logged out** → the shared `<GitHubAuthOptions />` (identical to the setup
 *   modal, DRY);
 * - **no worktree / no `origin`** → an explanatory message;
 * - **no open PR for the branch** → the create view;
 * - **an open PR** → the view view.
 *
 * Like `ChangesTab` it polls so externally created/merged PRs are reflected, and
 * drops in-flight responses for a stale worktree. Cache hits paint immediately;
 * background revalidation keeps merge status fresh while the tab is open.
 */
export function PullRequestTab({
  generatedDraft,
  generatedDraftKey,
}: {
  generatedDraft?: AiPullRequestDraft | null;
  generatedDraftKey?: number;
}) {
  const { authenticated, loading: authLoading } = useGitHub();
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktreeId;

  if (authLoading) {
    return <CenteredMessage tone="muted">Checking GitHub sign-in…</CenteredMessage>;
  }
  if (!authenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-xs text-muted-foreground">Sign in to GitHub to manage pull requests.</p>
        <GitHubAuthOptions className="w-full max-w-56" />
      </div>
    );
  }
  if (!worktreeId) {
    return (
      <CenteredMessage tone="muted">Select a worktree to manage its pull request.</CenteredMessage>
    );
  }
  return (
    <PullRequestResolver
      generatedDraft={generatedDraft}
      generatedDraftKey={generatedDraftKey}
      key={worktreeId}
      worktreeId={worktreeId}
    />
  );
}

type ResolveState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "create"; repo: GitHubRepoRef }
  | { kind: "view"; repo: GitHubRepoRef; pr: PullRequestSummary };

/** Resolves the repo ref + open PR for one worktree and renders the matching view. */
function PullRequestResolver({
  generatedDraft,
  generatedDraftKey,
  worktreeId,
}: {
  generatedDraft?: AiPullRequestDraft | null;
  generatedDraftKey?: number;
  worktreeId: string;
}) {
  const [state, setState] = useState<ResolveState>({ kind: "loading" });
  // Drops responses for a stale worktree (the resolver is keyed by worktree, so
  // this also guards against a poll landing after unmount).
  const active = useRef(true);
  const hasResolved = useRef(false);
  // Keep the last viewed PR number so a poll after merge still refreshes that PR
  // (open-only branch lookup would otherwise drop us onto the create view).
  const viewedPrNumber = useRef<number | null>(null);

  const refresh = useCallback(
    async (force = false) => {
      try {
        const repo = await githubRepoRef(worktreeId);
        let pr: PullRequestSummary | null = null;
        if (viewedPrNumber.current !== null) {
          // Prefer the known PR so merge/close status updates in place.
          try {
            pr = await getPullRequest(repo, viewedPrNumber.current, { force });
          } catch {
            pr = null;
            viewedPrNumber.current = null;
          }
        }
        if (!pr) {
          pr = await findPullRequestForBranch(repo, { force });
        }
        if (!active.current) {
          return;
        }
        hasResolved.current = true;
        if (pr) {
          viewedPrNumber.current = pr.number;
          setState({ kind: "view", repo, pr });
        } else {
          viewedPrNumber.current = null;
          setState({ kind: "create", repo });
        }
      } catch (cause) {
        if (active.current && !hasResolved.current) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      }
    },
    [worktreeId],
  );

  useEffect(() => {
    active.current = true;
    hasResolved.current = false;
    // Poll with force=false so cache serves stale-while-revalidate; the loop
    // still revalidates in the background on every tick + window focus.
    const stopRefresh = startRefreshLoop(() => refresh(false), PR_REFRESH_INTERVAL_MS);
    return () => {
      active.current = false;
      stopRefresh();
    };
  }, [refresh]);

  if (state.kind === "loading") {
    return <CenteredMessage tone="muted">Loading pull request…</CenteredMessage>;
  }
  if (state.kind === "error") {
    return <CenteredMessage tone="error">{state.message}</CenteredMessage>;
  }
  if (state.kind === "create") {
    return (
      <CreatePullRequestView
        initialDraft={generatedDraft}
        initialDraftKey={generatedDraftKey}
        onCreated={(pr) => {
          viewedPrNumber.current = pr.number;
          setState({ kind: "view", repo: state.repo, pr });
        }}
        repo={state.repo}
        worktreeId={worktreeId}
      />
    );
  }
  return (
    <ViewPullRequestView
      onChanged={() => void refresh(true)}
      pr={state.pr}
      repo={state.repo}
      worktreeId={worktreeId}
    />
  );
}

/** Small centered status line shared by the subtab's loading / empty / error states. */
function CenteredMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={`flex h-full items-center justify-center p-4 text-center text-xs ${
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}
