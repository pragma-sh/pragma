import type { GitHubPullRequest } from "@pragma/constants";
import { PragmaGatewayError, type AiJob } from "@pragma/sdk";
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
  /** Starts committing. Returns once the host has accepted the job. */
  start: () => Promise<void>;
  /** Asks the host to stop before its next step; commits already made stay. */
  cancel: () => Promise<void>;
  /** Pushes and creates the pull request from reviewed text. */
  publish: (input: { title: string; body: string; draft: boolean }) => Promise<void>;
  /** Clears a finished or failed run from the screen. */
  reset: () => void;
  /** Re-reads the branch's pull request. */
  refreshPullRequest: () => void;
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
  const [publishing, setPublishing] = useState(false);
  const [prRevision, setPrRevision] = useState(0);
  // The request id belongs to the attempt, not the render: a retry after a lost
  // response must reuse it so the host replays rather than repeats.
  const requestId = useRef<string | null>(null);

  const refreshPullRequest = useCallback(() => setPrRevision((value) => value + 1), []);

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

  const cancel = useCallback(async () => {
    if (!client || !job) return;
    await client.ai.cancelRun(job.jobId);
  }, [client, job]);

  const publish = useCallback(
    async (input: { title: string; body: string; draft: boolean }) => {
      if (!client || !root) throw new Error("Not connected to a host");
      setPublishing(true);
      try {
        const published = await client.github.publish({
          root,
          title: input.title,
          body: input.body,
          draft: input.draft,
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

  return {
    phase: phaseFor(job, publishing),
    job,
    pullRequest,
    start,
    cancel,
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
