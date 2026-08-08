import type { FileDiff } from "@pragma/constants";

import { cachedFetch } from "@/lib/github-cache";
import { githubPrFileDiff } from "@/lib/tauri";

/** Match the PR/review poll cadence so each tick can pick up local code changes. */
const PR_FILE_DIFF_TTL_MS = 10_000;

/** Cache key for one worktree-local `base...HEAD` file diff. */
export function prFileDiffCacheKey(
  worktreeId: string,
  base: string,
  path: string,
  oldPath?: string | null,
): string {
  return `pr-file-diff:${worktreeId}:${base}:${path}:${oldPath ?? ""}`;
}

/**
 * Read-through SWR cache over {@link githubPrFileDiff}. Fresh hits return
 * immediately; stale hits return now and revalidate in the background.
 */
export function loadPrFileDiff(
  worktreeId: string,
  base: string,
  path: string,
  oldPath?: string | null,
  options?: { force?: boolean },
): Promise<FileDiff> {
  return cachedFetch(
    prFileDiffCacheKey(worktreeId, base, path, oldPath),
    () => githubPrFileDiff(worktreeId, base, path, oldPath),
    { force: options?.force, ttlMs: PR_FILE_DIFF_TTL_MS },
  );
}

/** True when both sides render the same text (skip remounting MergeDiff). */
export function fileDiffsEqual(left: FileDiff | null, right: FileDiff): boolean {
  if (!left) {
    return false;
  }
  return (
    left.binary === right.binary && left.oldText === right.oldText && left.newText === right.newText
  );
}
