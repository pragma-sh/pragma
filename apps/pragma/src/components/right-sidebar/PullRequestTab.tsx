import { useCallback, useEffect, useRef, useState } from "react";

import type { GitHubRepoRef } from "@pragma/constants";

import { CreatePullRequestView } from "@/components/github/CreatePullRequestView";
import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { ViewPullRequestView } from "@/components/github/ViewPullRequestView";
import { findPullRequestForBranch, type PullRequestSummary } from "@/lib/github";
import { type AiPullRequestDraft, githubRepoRef } from "@/lib/tauri";
import { useGitHub } from "@/state/github-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * How often the Pull Request subtab re-resolves its state while mounted. GitHub
 * has no push channel here, so we poll like `ChangesTab` — but at a slower beat,
 * since each refresh is a remote API round-trip subject to rate limits and PR
 * state changes far less often than the working tree.
 */
const PR_REFRESH_INTERVAL_MS = 10_000;

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The Pull Request subtab controller. Resolves, in order:
 * - **logged out** → the shared `<GitHubAuthOptions />` (identical to the setup
 *   modal, DRY);
 * - **no worktree / no `origin`** → an explanatory message;
 * - **no open PR for the branch** → the create view;
 * - **an open PR** → the view view.
 *
 * Like `ChangesTab` it polls so externally created/merged PRs are reflected, and
 * drops in-flight responses for a stale worktree.
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
        <p className="text-xs text-slate-400">Sign in to GitHub to manage pull requests.</p>
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

  const refresh = useCallback(async () => {
    try {
      const repo = await githubRepoRef(worktreeId);
      const pr = await findPullRequestForBranch(repo);
      if (!active.current) {
        return;
      }
      setState(pr ? { kind: "view", repo, pr } : { kind: "create", repo });
    } catch (cause) {
      if (active.current) {
        setState({ kind: "error", message: messageFor(cause) });
      }
    }
  }, [worktreeId]);

  useEffect(() => {
    active.current = true;
    void refresh();
    const interval = setInterval(() => void refresh(), PR_REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active.current = false;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
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
        onCreated={(pr) => setState({ kind: "view", repo: state.repo, pr })}
        repo={state.repo}
        worktreeId={worktreeId}
      />
    );
  }
  return (
    <ViewPullRequestView
      onChanged={() => void refresh()}
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
        tone === "error" ? "text-destructive" : "text-slate-500"
      }`}
    >
      {children}
    </div>
  );
}
