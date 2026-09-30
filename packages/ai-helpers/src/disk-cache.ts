/**
 * A versioned, TTL-bound JSON cache file under the user's home directory,
 * shared by every third-party catalog the sidecar fetches (modelgrep model
 * insights, Terminal-Bench harness insights).
 *
 * The envelope is `{ version, fetchedAt, [payloadKey]: payload }`. A cache is
 * only served when its version matches, it is younger than the TTL, and its
 * `fetchedAt` is not in the future (a clock that moved backwards must not pin a
 * stale file forever). Every read failure is a miss, never an error.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Identifies one cache file and how long it stays fresh. */
export interface DiskCacheSpec {
  path: string;
  version: number;
  ttlHours: number;
  /** Envelope key holding the payload, e.g. `insights`. */
  payloadKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whether `fetchedAt` is a parseable time no older than `ttlHours` and not in the future. */
function isFresh(fetchedAt: unknown, ttlHours: number, now: Date): boolean {
  if (typeof fetchedAt !== "string") return false;
  const time = new Date(fetchedAt).getTime();
  if (Number.isNaN(time)) return false;
  const ageHours = (now.getTime() - time) / 3_600_000;
  return ageHours >= 0 && ageHours <= ttlHours;
}

/**
 * Returns the cached payload when the file exists, parses, matches the spec's
 * version, and is fresh; otherwise `null`. The payload is returned unvalidated —
 * the caller re-parses it field by field.
 */
export async function readDiskCache(spec: DiskCacheSpec, now: Date): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(spec.path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== spec.version) return null;
  if (!isFresh(parsed.fetchedAt, spec.ttlHours, now)) return null;
  return parsed[spec.payloadKey] ?? null;
}

/**
 * Writes the payload inside a fresh envelope. Failures are swallowed: a
 * read-only home directory must degrade to "no cache", not break the caller.
 */
export async function writeDiskCache(
  spec: DiskCacheSpec,
  payload: unknown,
  now: Date,
): Promise<void> {
  const file = { version: spec.version, fetchedAt: now.toISOString(), [spec.payloadKey]: payload };
  try {
    await mkdir(dirname(spec.path), { recursive: true });
    await writeFile(spec.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  } catch {
    // See above: caching is best-effort.
  }
}
