import type { GitHubPullRequest } from "@pragma-sh/constants";
import type {
  AiJob,
  AiJobStage,
  GitHubBranches,
  PragmaClient,
  WorktreeChanges,
} from "@pragma-sh/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useConnection } from "./connection-context";
import { settle, type Settled } from "./host-read";
import { errorText } from "./utils";

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
  const [publishing, setPublishing] = useState(false);
  // The request id belongs to the attempt, not the render: a retry after a lost
  // response must reuse it so the host replays rather than repeats.
  const requestId = useRef<string | null>(null);

  const githubReady = useGithubReady(client, handleUnauthorized);
  const hasChanges = useHasChanges(client, root, handleUnauthorized, job?.stage);
  const { branches, branchesError, refreshBranches } = useBaseBranches(
    client,
    githubReady ? root : undefined,
    handleUnauthorized,
  );
  const { pullRequest, setPullRequest, refreshPullRequest } = usePullRequest(
    client,
    root,
    handleUnauthorized,
  );
  useJobRefresh(client, job, setJob);

  const start = useCallback(async () => {
    if (!client) throw new Error("Not connected to a host");
    requestId.current ??= `${worktreeId}:${Date.now()}`;
    setJob(await client.ai.commitAndDraftPullRequest({ worktreeId, requestId: requestId.current }));
  }, [client, worktreeId]);

  const publish = useCallback(
    async (input: PublishInput) => {
      if (!client || !root) throw new Error("Not connected to a host");
      setPublishing(true);
      try {
        setPullRequest(
          await client.github.publish(publishRequest(root, input, requestId.current ?? worktreeId)),
        );
        setJob(null);
        requestId.current = null;
      } finally {
        setPublishing(false);
      }
    },
    [client, root, setPullRequest, worktreeId],
  );

  const reset = useCallback(() => {
    setJob(null);
    requestId.current = null;
  }, []);

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

type PublishInput = Parameters<CommitAndPr["publish"]>[0];

/** The publish request for reviewed text, keyed off the run that made the commits. */
function publishRequest(root: string, input: PublishInput, attemptId: string) {
  return {
    root,
    title: input.title,
    body: input.body,
    draft: input.draft,
    ...(input.base ? { base: input.base } : {}),
    requestId: `${attemptId}:publish`,
  };
}

/**
 * Runs `load` whenever it or `revision` changes, handing it a `live()` check so
 * an answer that arrives after the effect is torn down is dropped. Bumping
 * `revision` is how a caller asks for a re-read.
 */
function useCancellableLoad(
  load: ((live: () => boolean) => Promise<void>) | null,
  revision = 0,
): void {
  useEffect(() => {
    if (!load) return undefined;
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, revision]);
}

/**
 * Whether the host is signed in to GitHub. Asked once per connection rather
 * than per render: the answer is a stored token, and the host re-checks it
 * against GitHub on every call.
 */
function useGithubReady(client: PragmaClient | null, onUnauthorized: () => void): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  const load = useMemo(() => {
    if (!client) return async () => setReady(null);
    return async (live: () => boolean) => {
      const result = await settle(client.github.status(), onUnauthorized);
      // An unreachable host is not a signed-out one; leave it unknown so the
      // screen does not accuse the user of having no token.
      if (live()) setReady(result.ok ? result.value.authenticated : null);
    };
  }, [client, onUnauthorized]);
  useCancellableLoad(load);
  return ready;
}

/**
 * Whether the worktree has anything uncommitted. Read on focus rather than on a
 * timer: the answer only matters when the user is looking at the action, and a
 * phone should not poll git in the background.
 */
function useHasChanges(
  client: PragmaClient | null,
  root: string | undefined,
  onUnauthorized: () => void,
  stage: AiJobStage | undefined,
): boolean | null {
  const [hasChanges, setHasChanges] = useState<boolean | null>(null);
  const readChanges = useCallback(async () => {
    const result =
      client && root ? await settle(client.git.worktreeChanges({ root }), onUnauthorized) : null;
    setHasChanges(uncommitted(result));
  }, [client, onUnauthorized, root]);

  useFocusEffect(
    useCallback(() => {
      void readChanges();
    }, [readChanges]),
  );

  // A finished run is what made the worktree clean, so re-read on the stage
  // that finished it rather than waiting for the screen to be focused again.
  useEffect(() => {
    if (stage === undefined) return;
    void readChanges();
  }, [readChanges, stage]);

  return hasChanges;
}

/**
 * Unknown, not clean, when the read failed: a failed read must not disable the
 * action on a worktree that has plenty to commit.
 */
function uncommitted(result: Settled<WorktreeChanges> | null): boolean | null {
  if (!result?.ok) return null;
  return result.value.staged.length > 0 || result.value.unstaged.length > 0;
}

/**
 * Branches a pull request could merge into. `root` is passed only once the host
 * is known to be signed in — not only once a draft exists: the picker is the
 * first thing shown on the review step, and a list that starts loading then
 * leaves the user with a menu that opens empty.
 */
function useBaseBranches(
  client: PragmaClient | null,
  root: string | undefined,
  onUnauthorized: () => void,
) {
  const [branches, setBranches] = useState<GitHubBranches | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  // Bumped to re-read the branch list: a run that just made commits does not
  // change it, but a failed read should be retryable from the picker.
  const [revision, setRevision] = useState(0);
  const load = useMemo(() => {
    if (!client || !root) return null;
    return async (live: () => boolean) => {
      const result = await settle(client.github.branches(root), onUnauthorized);
      if (!live()) return;
      if (result.ok) {
        setBranches(result.value);
        setBranchesError(null);
      } else {
        // Without the list the publish still works — it goes to the default
        // branch — but the picker must say so rather than opening empty.
        setBranchesError(errorText(result.error, "The branch list could not be read."));
      }
    };
  }, [client, onUnauthorized, root]);
  useCancellableLoad(load, revision);
  const refreshBranches = useCallback(() => setRevision((value) => value + 1), []);
  return { branches, branchesError, refreshBranches };
}

/** The branch's pull request, if it has one. */
function usePullRequest(
  client: PragmaClient | null,
  root: string | undefined,
  onUnauthorized: () => void,
) {
  const [pullRequest, setPullRequest] = useState<GitHubPullRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useMemo(() => {
    if (!client || !root) return async () => setPullRequest(null);
    return async (live: () => boolean) => {
      // Signed out, offline, or not a GitHub remote: the row simply does not
      // appear, rather than showing an error on a repo that works fine.
      const result = await settle(client.github.pullRequest(root), onUnauthorized);
      if (live() && result.ok) setPullRequest(result.value);
    };
  }, [client, onUnauthorized, root]);
  useCancellableLoad(load, revision);
  const refreshPullRequest = useCallback(() => setRevision((value) => value + 1), []);
  return { pullRequest, setPullRequest, refreshPullRequest };
}

/**
 * Keeps the run current: polled while the host says it is going, and re-read on
 * coming back to the screen rather than trusting what was on it — the host kept
 * working while the app was away.
 */
function useJobRefresh(
  client: PragmaClient | null,
  job: AiJob | null,
  setJob: (job: AiJob) => void,
): void {
  const running = job !== null && phaseFor(job, false) === "running";
  const jobId = job?.jobId;
  useEffect(() => {
    if (!client || !jobId || !running) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const next = await readRun(client, jobId);
      if (!cancelled && next) setJob(next);
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, jobId, running, setJob]);

  useFocusEffect(
    useCallback(() => {
      if (!client || !jobId) return;
      const refresh = async (): Promise<void> => {
        const next = await readRun(client, jobId);
        if (next) setJob(next);
      };
      void refresh();
    }, [client, jobId, setJob]),
  );
}

/**
 * The run's current record, or null when it could not be read. A missed read
 * is not a state change: the next one will say where the run got to, and the
 * host is the one keeping track — so the last known state stays on screen.
 */
async function readRun(client: PragmaClient, jobId: string): Promise<AiJob | null> {
  try {
    return await client.ai.getRun(jobId);
  } catch {
    return null;
  }
}

/** What the screen shows for each stage; anything absent has failed. */
const PHASE_BY_STAGE: Partial<Record<AiJobStage, CommitAndPrPhase>> = {
  planning: "running",
  committing: "running",
  drafting: "running",
  ready: "review",
};

/**
 * Maps the host's stage onto what the screen shows. Failed, cancelled, and
 * interrupted all need the same thing from the screen: say what happened, and
 * say what was committed anyway.
 */
function phaseFor(job: AiJob | null, publishing: boolean): CommitAndPrPhase {
  if (publishing) return "publishing";
  if (!job) return "idle";
  return PHASE_BY_STAGE[job.stage] ?? "failed";
}

const STAGE_LABELS: Partial<Record<AiJobStage, string>> = {
  planning: "Reading your changes…",
  committing: "Committing…",
  drafting: "Writing the pull request…",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

/** What the user is told a running job is doing. */
export function stageLabel(job: AiJob): string {
  if (job.stage === "ready") {
    return `${job.commitCount} ${job.commitCount === 1 ? "commit" : "commits"} created`;
  }
  return STAGE_LABELS[job.stage] ?? "Failed";
}
