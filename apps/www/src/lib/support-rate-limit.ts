/**
 * A best-effort per-connection cap on support-form submissions, so a flood
 * from one address cannot spend the form's shared splitforms quota or bury
 * the inbox. Kept separate from the "use server" action module so the pure
 * counting logic is directly testable; the action supplies the connection
 * key (see `clientKey` there).
 *
 * This is in-memory and per-process: a serverless deployment runs many
 * processes, so the real ceiling is a multiple of `RATE_LIMIT_MAX`, not an
 * exact one. It still caps what any single warm instance will forward.
 */

export const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const submissionTimestamps = new Map<string, number[]>();

/**
 * Whether `key` has already spent its quota within the current window.
 * Records this attempt when it has not.
 */
export function isRateLimited(key: string, now: number = Date.now()): boolean {
  const recent = (submissionTimestamps.get(key) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    submissionTimestamps.set(key, recent);
    return true;
  }
  recent.push(now);
  submissionTimestamps.set(key, recent);
  return false;
}

/** Test-only: clear every recorded submission so tests cannot see each other's calls. */
export function resetRateLimiterForTests(): void {
  submissionTimestamps.clear();
}
