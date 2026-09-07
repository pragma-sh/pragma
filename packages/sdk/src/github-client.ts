// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type { GitHubPullRequest } from "@pragma/constants";

import { routes } from "./routes";
import type { Transport } from "./transport";

/** Whether the host holds a usable GitHub token, and whose it is. */
export interface GitHubStatus {
  authenticated: boolean;
  login: string | null;
  /** Why the host could not confirm the token, when it could not. */
  error?: string;
}

/** Options for {@link GitHubClient.publish}. */
export interface PublishPullRequestOptions {
  /** Absolute worktree root whose branch is being published. */
  root: string;
  title: string;
  body: string;
  /** Base branch. Omit to use the repository's default. */
  base?: string;
  draft?: boolean;
  /**
   * Caller-generated id. Reuse it when retrying: a push can succeed and the
   * create response be lost, and a blind retry would open a second pull request.
   */
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for GitHub.
 *
 * The token stays on the host — there is deliberately no method that returns it,
 * because this namespace is reachable from a paired phone. Clients ask the host
 * to *do* things and get pull requests back.
 */
export class GitHubClient {
  constructor(private readonly transport: Transport) {}

  /** Whether the host is signed in to GitHub, and as whom. */
  status(options: { signal?: AbortSignal } = {}): Promise<GitHubStatus> {
    return this.githubRpc<GitHubStatus>({ action: "status" }, options.signal);
  }

  /**
   * The pull request for a worktree's branch, or null when it has none.
   *
   * Found by repository plus exact head branch, so one opened outside Pragma —
   * on the web, from another machine — is found too. A merged or closed one
   * still counts: a branch whose pull request was merged is finished, not
   * un-published.
   */
  async pullRequest(
    root: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubPullRequest | null> {
    const result = await this.githubRpc<{ pullRequest: GitHubPullRequest | null }>(
      { action: "pullRequest", root },
      options.signal,
    );
    return result.pullRequest;
  }

  /** Pushes the branch and creates its pull request. */
  async publish(options: PublishPullRequestOptions): Promise<GitHubPullRequest> {
    const result = await this.githubRpc<{ pullRequest: GitHubPullRequest }>(
      {
        action: "publishPullRequest",
        root: options.root,
        title: options.title,
        body: options.body,
        ...(options.base ? { base: options.base } : {}),
        draft: options.draft ?? false,
        requestId: options.requestId,
      },
      options.signal,
    );
    return result.pullRequest;
  }

  private githubRpc<T>(body: unknown, signal?: AbortSignal): Promise<T> {
    return this.transport.request<T>(routes.rpc("github"), { method: "POST", body, signal });
  }
}
