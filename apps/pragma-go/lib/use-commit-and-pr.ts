import type { GitHubPullRequest } from "@pragma/constants";
import { PragmaGatewayError, type AiJob, type GitHubBranches } from "@pragma/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "./connection-context";

/** How often a running job is re-read. The work is minutes long, not seconds. */
const POLL_MS = 1_500;

/** Where the Commit & PR flow is, from the screen's point of view. */
export type CommitAndPrPhase =
  /** Nothing started. */
  | "idle"
  /** The host is planning and committing. */
  | "running"
  /** Commits are made; the draft is waiting to be reviewed. */
  | "review"
  /** Pushing and creating the pull request. */
  | "publishing"
  /** The run failed, was cancelled, or was interrupted. */
  | "failed";

/** The Commit & PR flow for one worktree. */
export interface CommitAndPr {
  phase: CommitAndPrPhase;
  /** The host's record of the run, once one has started. */
  job: AiJob | null;
  /** The pull request for this branch, if it has one. */
  pullRequest: GitHubPullRequest | null;
  /**
   * Whether the host is signed in to GitHub — `null` until the first answer.
   *
   * The flow ends in a push and a pull request, so a host with no token can
   * only get as far as commits it never asked for. The screen therefore blocks
   * the whole flow rather than failing at the last step.
   */
  githubReady: boolean | null;
  /** Branches this pull request can merge into, once they are known. */
  branches: GitHubBranches | null;
  /** Why the branch list could not be read, when it could not. */
  branchesError: string | null;
  /**
   * Whether the worktree has anything uncommitted — `null` until the first
   * answer. A clean worktree has nothing for the flow to commit, so the desktop
   * disables its Commit & PR button on the same condition.
   */
  hasChanges: boolean | null;
  /** Starts committing. Returns once the host has accepted the job. */
  start: () => Promise<void>;
  /** Pushes and creates the pull request from reviewed text. */
  publish: (input: {
    title: string;
    body: string;
    draft: boolean;
    /** Branch to merge into. Omitted means the repository's default. */
    base?: string;
  }) => Promise<void>;
  /** Clears a finished or failed run from the screen. */
  reset: () => void;
  /** Re-reads the branch's pull request. */
  refreshPullRequest: () => void;
  /** Re-reads the branches a pull request could merge into. */
  refreshBranches: () => void;
}

/**
 * Drives commit-then-review-then-publish against the host.
 *
 * Three things this deliberately does not do. It does not hold the run: the
 * host does, so leaving the screen — or losing signal — does not cancel or
 * duplicate anything. It does not publish as part of committing: a commit is
 * local and a publish is not, and the text is reviewed in between. And it does
 * not retry a mutation on its own; every start and publish carries a request id
 * the host dedupes on, and a retry is the user's decision.
 */
export function useCommitAndPr(worktreeId: string, root: string | undefined): CommitAndPr {
  const { client, handleUnauthorized } = useConnection();
  const [job, setJob] = useState<AiJob | null>(null);
  const [pullRequest, setPullRequest] = useState<GitHubPullRequest | null>(null);
  const [githubReady, setGithubReady] = useState<boolean | null>(null);
  const [branches, setBranches] = useState<GitHubBranches | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  // Bumped to re-read the branch list: a run that just made commits does not
  // change it, but a failed read should be retryable from the picker.
  const [branchRevision, setBranchRevision] = useState(0);
  const [hasChanges, setHasChanges] = useState<boolean | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [prRevision, setPrRevision] = useState(0);
  // The request id belongs to the attempt, not the render: a retry after a lost
  // response must reuse it so the host replays rather than repeats.
  const requestId = useRef<string | null>(null);

  const refreshPullRequest = useCallback(() => setPrRevision((value) => value + 1), []);

  // Asked once per connection rather than per render: the answer is a stored
  // token, and the host re-checks it against GitHub on every call.
  useEffect(() => {
    if (!client) {
      setGithubReady(null);
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const status = await client.github.status();
        if (!cancelled) setGithubReady(status.authenticated);
      } catch (error: unknown) {
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
        // An unreachable host is not a signed-out one; leave it unknown so the
        // screen does not accuse the user of having no token.
        if (!cancelled) setGithubReady(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized]);

  // Read on focus rather than on a timer: the answer only matters when the user
  // is looking at the action, and a phone should not poll git in the background.
  const readChanges = useCallback(async () => {
    if (!client || !root) {
      setHasChanges(null);
      return;
    }
    try {
      const changes = await client.git.worktreeChanges({ root });
      setHasChanges(changes.staged.length > 0 || changes.unstaged.length > 0);
    } catch (error: unknown) {
      if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      // Unknown, not clean: a failed read must not disable the action on a
      // worktree that has plenty to commit.
      setHasChanges(null);
    }
  }, [client, handleUnauthorized, root]);

  useFocusEffect(
    useCallback(() => {
      void readChanges();
    }, [readChanges]),
  );

  // A finished run is what made the worktree clean, so re-read on the stage
  // that finished it rather than waiting for the screen to be focused again.
  const stage = job?.stage;
  useEffect(() => {
    if (stage === undefined) return;
    void readChanges();
  }, [readChanges, stage]);

  // Read as soon as the host is known to be signed in, not only once a draft
  // exists: the picker is the first thing shown on the review step, and a list
  // that starts loading then leaves the user with a menu that opens empty.
  useEffect(() => {
    if (!client || !root || !githubReady) return undefined;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const found = await client.github.branches(root);
        if (cancelled) return;
        setBranches(found);
        setBranchesError(null);
      } catch (error: unknown) {
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
        // Without the list the publish still works — it goes to the default
        // branch — but the picker must say so rather than opening empty.
        if (!cancelled) {
          setBranchesError(
            error instanceof Error ? error.message : "The branch list could not be read.",
          );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [branchRevision, client, githubReady, handleUnauthorized, root]);

  useEffect(() => {
    if (!client || !root) {
      setPullRequest(null);
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const found = await client.github.pullRequest(root);
        if (!cancelled) setPullRequest(found);
      } catch (error: unknown) {
        // Signed out, offline, or not a GitHub remote: the row simply does not
        // appear, rather than showing an error on a repo that works fine.
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized, prRevision, root]);

  // Poll only while the host says the run is going.
  const running = job !== null && ["planning", "committing", "drafting"].includes(job.stage);
  useEffect(() => {
    if (!client || !job || !running) return undefined;
    const jobId = job.jobId;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await client.ai.getRun(jobId);
        if (!cancelled && next) setJob(next);
      } catch {
        // A missed poll is not a state change: the next one will say where the
        // run got to, and the host is the one keeping track.
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, job, running]);

  // Coming back to the screen re-reads the run rather than trusting what was on
  // it: the host kept working while the app was away.
  useFocusEffect(
    useCallback(() => {
      if (!client || !job) return;
      const refresh = async (): Promise<void> => {
        try {
          const next = await client.ai.getRun(job.jobId);
          if (next) setJob(next);
        } catch {
          // Leave the last known state on screen rather than blanking it.
        }
      };
      void refresh();
    }, [client, job]),
  );

  const start = useCallback(async () => {
    if (!client) throw new Error("Not connected to a host");
    requestId.current ??= `${worktreeId}:${Date.now()}`;
    setJob(await client.ai.commitAndDraftPullRequest({ worktreeId, requestId: requestId.current }));
  }, [client, worktreeId]);

  const publish = useCallback(
    async (input: { title: string; body: string; draft: boolean; base?: string }) => {
      if (!client || !root) throw new Error("Not connected to a host");
      setPublishing(true);
      try {
        const published = await client.github.publish({
          root,
          title: input.title,
          body: input.body,
          draft: input.draft,
          ...(input.base ? { base: input.base } : {}),
          requestId: `${requestId.current ?? worktreeId}:publish`,
        });
        setPullRequest(published);
        setJob(null);
        requestId.current = null;
      } finally {
        setPublishing(false);
      }
    },
    [client, root, worktreeId],
  );

  const reset = useCallback(() => {
    setJob(null);
    requestId.current = null;
  }, []);

  const refreshBranches = useCallback(() => setBranchRevision((value) => value + 1), []);

  return {
    phase: phaseFor(job, publishing),
    job,
    pullRequest,
    githubReady,
    branches,
    branchesError,
    refreshBranches,
    hasChanges,
    start,
    publish,
    reset,
    refreshPullRequest,
  };
}

/** Maps the host's stage onto what the screen shows. */
function phaseFor(job: AiJob | null, publishing: boolean): CommitAndPrPhase {
  if (publishing) return "publishing";
  if (!job) return "idle";
  switch (job.stage) {
    case "planning":
    case "committing":
    case "drafting":
      return "running";
    case "ready":
      return "review";
    default:
      // Failed, cancelled, and interrupted all need the same thing from the
      // screen: say what happened, and say what was committed anyway.
      return "failed";
  }
}

/** What the user is told a running job is doing. */
export function stageLabel(job: AiJob): string {
  switch (job.stage) {
    case "planning":
      return "Reading your changes…";
    case "committing":
      return "Committing…";
    case "drafting":
      return "Writing the pull request…";
    case "ready":
      return `${job.commitCount} ${job.commitCount === 1 ? "commit" : "commits"} created`;
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
    default:
      return "Failed";
  }
}
