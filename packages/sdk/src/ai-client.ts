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

  /**
   * Writes a commit message for what is currently staged.
   *
   * Staged, not everything: it describes what the user has already chosen to
   * commit.
   */
  async generateCommitMessage(
    worktreeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const result = await this.aiRpc<{ message: string }>(
      { action: "generateCommitMessage", worktreeId },
      options.signal,
    );
    return result.message;
  }

  /** Drafts pull request text for the commits already on this branch. */
  generatePullRequestDraft(
    worktreeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ title: string; body: string }> {
    return this.aiRpc<{ title: string; body: string }>(
      { action: "generatePullRequestDraft", worktreeId },
      options.signal,
    );
  }

  /**
   * Proposes an edit to a document.
   *
   * The document travels in the request rather than being read from disk: the
   * buffer the user is editing is what they mean, and it may not be saved yet.
   */
  inlineEdit(
    input: {
      worktreeId: string;
      filePath: string;
      instruction: string;
      doc: string;
      startLine: number;
      endLine: number;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ summary: string; edits: { oldText: string; newText: string }[] }> {
    return this.aiRpc({ action: "inlineEdit", ...input }, options.signal);
  }

  /**
   * Asks a question about the code.
   *
   * Read-only by construction. Anything that should be able to change files
   * goes through `agents.launch`, where the user can see and approve what it
   * does — a second unrestricted agent runtime is not what this is.
   *
   * Aborting the request stops the client waiting; the host's own work is
   * short-lived and harmless, because nothing here writes.
   */
  async ask(
    input: { worktreeId: string; question: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const result = await this.aiRpc<{ text: string }>(
      { action: "ask", worktreeId: input.worktreeId, question: input.question, worktrees: [] },
      options.signal,
    );
    return result.text;
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
