// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { routes } from "./routes";
import type { Transport } from "./transport";

/** Whether the host can run AI operations at all. */
export interface AiStatus {
  available: boolean;
  signedIn: boolean;
  /** Why the host could not answer, when it could not. */
  error?: string;
}

/**
 * Where a commit-and-draft run has got to.
 *
 * More than "running" on purpose: after a failure, the difference between "still
 * asking the model" and "already made three commits" is exactly what tells the
 * user whether there is anything on their branch.
 */
export type AiJobStage =
  | "planning"
  | "committing"
  | "drafting"
  | "ready"
  | "failed"
  | "cancelled"
  /** The host stopped mid-run. Commits it had already made are still there. */
  | "interrupted";

/** One commit-and-draft run. */
export interface AiJob {
  jobId: string;
  requestId: string;
  worktreeId: string;
  stage: AiJobStage;
  /** Commits made so far — meaningful in every stage, including a failure. */
  commitCount: number;
  title: string | null;
  body: string | null;
  error: string | null;
}

/** Options for {@link AiClient.commitAndDraftPullRequest}. */
export interface CommitAndDraftOptions {
  worktreeId: string;
  /**
   * Caller-generated id. Reuse it when retrying: this operation makes commits,
   * and starting it twice would commit the same work under two sets of
   * messages.
   */
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for the host's AI operations.
 *
 * Committing is a **job**, not a request/response: it plans, makes several
 * commits, then drafts the pull request text, and the client that started it may
 * be backgrounded or offline long before it finishes. So this returns a job
 * immediately and the client polls it — and the host, not the client, is what
 * remembers what happened.
 */
export class AiClient {
  constructor(private readonly transport: Transport) {}

  /** Whether the host can run AI operations, and is signed in to a provider. */
  status(options: { signal?: AbortSignal } = {}): Promise<AiStatus> {
    return this.aiRpc<AiStatus>({ action: "status" }, options.signal);
  }

  /**
   * Commits all dirty changes as logical commits, then drafts pull request
   * text for review. It does **not** publish: see `client.github.publish`.
   */
  commitAndDraftPullRequest(options: CommitAndDraftOptions): Promise<AiJob> {
    return this.aiRpc<AiJob>(
      {
        action: "commitAndDraftPullRequest",
        worktreeId: options.worktreeId,
        requestId: options.requestId,
      },
      options.signal,
    );
  }

  /** Reads a run's current stage and result. */
  getRun(runId: string, options: { signal?: AbortSignal } = {}): Promise<AiJob | null> {
    return this.aiRpc<AiJob | null>({ action: "getRun", runId }, options.signal);
  }

  /**
   * Asks a run to stop before its next step.
   *
   * This does not undo commits. Anything already committed stays committed —
   * rewriting history to "cancel" would destroy work the user can see.
   */
  async cancelRun(runId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.aiRpc({ action: "cancelRun", runId }, options.signal);
  }

  private aiRpc<T>(body: unknown, signal?: AbortSignal): Promise<T> {
    return this.transport.request<T>(routes.rpc("ai"), { method: "POST", body, signal });
  }
}
