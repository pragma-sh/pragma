import type { GitHubRepoRef } from "@pragma-sh/constants";

import type { PullFile, PullRequestSummary, PullReview, ReviewThread } from "@/lib/github";

/**
 * How often the review tab re-fetches PR metadata, files, comments, and local
 * diffs while mounted. Matches the Pull Request sidebar cadence: GitHub has no
 * push channel here, and cached responses keep each tick cheap.
 */
export const REVIEW_REFRESH_INTERVAL_MS = 10_000;

/** Everything the review tab renders for one pull request. */
export interface ReviewData {
  repo: GitHubRepoRef;
  pr: PullRequestSummary;
  files: PullFile[];
  reviews: PullReview[];
  threadsByPath: Map<string, ReviewThread[]>;
}

/** Group review threads into a per-path map (file order is preserved by the caller). */
export function groupThreadsByPath(threads: ReviewThread[]): Map<string, ReviewThread[]> {
  const map = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const bucket = map.get(thread.path);
    if (bucket) {
      bucket.push(thread);
    } else {
      map.set(thread.path, [thread]);
    }
  }
  return map;
}

/** Every review thread's id, in file-then-thread order, for toolbar navigation. */
export function buildCommentKeys(
  files: PullFile[],
  threadsByPath: Map<string, ReviewThread[]>,
): string[] {
  const keys: string[] = [];
  for (const file of files) {
    for (const thread of threadsByPath.get(file.path) ?? []) {
      keys.push(thread.id);
    }
  }
  return keys;
}

/** Flatten path → threads for seeding the GitHub SWR store after an optimistic flip. */
export function flattenThreads(threadsByPath: Map<string, ReviewThread[]>): ReviewThread[] {
  const threads: ReviewThread[] = [];
  for (const list of threadsByPath.values()) {
    threads.push(...list);
  }
  return threads;
}

function fileSignature(file: PullFile): string {
  return `${file.path}:${file.oldPath ?? ""}:${file.status}:${file.additions}:${file.deletions}`;
}

function threadsSignature(threads: ReviewThread[]): string {
  return threads
    .map(
      (thread) =>
        `${thread.id}:${thread.isResolved}:${thread.line}:${thread.comments
          .map((comment) => `${comment.id}:${comment.body}`)
          .join(",")}`,
    )
    .join("|");
}

/** Compact signature so background refreshes can skip no-op React updates. */
export function reviewDataSignature(data: ReviewData): string {
  const files = data.files.map(fileSignature).join("|");
  const reviews = data.reviews
    .map((review) => `${review.id}:${review.state}:${review.body}`)
    .join("|");
  const threads = [...data.threadsByPath.entries()]
    .map(([path, list]) => `${path}=${threadsSignature(list)}`)
    .join("|");
  const pr = data.pr;
  return `${pr.number}:${pr.headSha}:${pr.title}:${pr.state}:${pr.merged}:${pr.baseRef}:${files}:${reviews}:${threads}`;
}

/**
 * Structural sharing for a refreshed snapshot: every file object and per-path
 * thread list that did not change keeps its previous reference. File sections
 * are memoized on those references, so a new comment on one file re-renders
 * that file alone instead of every diff in the pull request.
 */
export function reuseUnchangedReviewData(prev: ReviewData, next: ReviewData): ReviewData {
  const prevFiles = new Map(prev.files.map((file) => [file.path, file]));
  const files = next.files.map((file) => {
    const previous = prevFiles.get(file.path);
    return previous && fileSignature(previous) === fileSignature(file) ? previous : file;
  });
  const threadsByPath = new Map<string, ReviewThread[]>();
  for (const [path, list] of next.threadsByPath) {
    const previous = prev.threadsByPath.get(path);
    threadsByPath.set(
      path,
      previous && threadsSignature(previous) === threadsSignature(list) ? previous : list,
    );
  }
  return { ...next, files, threadsByPath };
}
