import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

/** Options accepted by `ctx.fs.find`. */
export interface FindOptions {
  name?: string;
  minBytes?: number;
}

// Missing or unreadable paths (ENOENT, EPERM, …) are skipped, not fatal —
// a watcher polling for a file that does not exist yet must not throw.
async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readdirSafe(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Directories a project-scoped search must never descend into. They are
 * machine-generated, enormous, and never what an automation is watching for —
 * `.pragma` in particular holds `worktrees/`, which multiplies the whole tree
 * by the number of worktrees.
 */
const FIND_SKIP_DIRS = new Set([
  ".git",
  ".pragma",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
]);

/**
 * Directories walked at once. The walk used to recurse with an unbounded
 * `Promise.all` per directory, so a large tree opened thousands of concurrent
 * handles and the sidecar died with `EMFILE: too many open files`.
 */
const FIND_CONCURRENCY = 8;

/** Depth cap, so a pathological tree cannot turn a poll into an endless walk. */
const FIND_MAX_DEPTH = 12;

function fileMatches(path: string, size: number | bigint, options: FindOptions): boolean {
  if (options.name !== undefined && basename(path) !== options.name) return false;
  return options.minBytes === undefined || size >= options.minBytes;
}

/** True when `candidate` stays inside `root`. */
function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Lists files under `start`, relative to the automation `root`.
 */
export async function findFiles(
  root: string,
  start: string,
  options: FindOptions = {},
): Promise<string[]> {
  const base = resolve(root, start);
  if (!within(root, base)) throw new Error("path escapes automation root");
  const result: string[] = [];
  const baseInfo = await statSafe(base);
  if (!baseInfo) return result;
  if (!baseInfo.isDirectory()) {
    if (fileMatches(base, baseInfo.size, options)) result.push(relative(root, base));
    return result;
  }

  // Breadth-first with a fixed-width wave rather than recursive `Promise.all`:
  // the number of directories open at once is bounded, so a big tree costs
  // time instead of file descriptors.
  let level: string[] = [base];
  for (let depth = 0; depth < FIND_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += FIND_CONCURRENCY) {
      const wave = level.slice(index, index + FIND_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop -- serialising the waves is the point: it is what bounds open file descriptors
      const listings = await Promise.all(wave.map((dir) => readdirSafe(dir)));
      for (const [waveIndex, entries] of listings.entries()) {
        const dir = wave[waveIndex];
        if (dir === undefined) continue;
        for (const entry of entries) {
          const path = join(dir, entry.name);
          // Symlinks are not followed: a link back up the tree would loop, and
          // a link out of the root would escape it.
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!FIND_SKIP_DIRS.has(entry.name)) next.push(path);
            continue;
          }
          if (!entry.isFile()) continue;
          // Name mismatches are rejected before the `stat`, so the common
          // "watch for one filename" poll never touches most files at all.
          if (options.name !== undefined && entry.name !== options.name) continue;
          if (options.minBytes === undefined) {
            result.push(relative(root, path));
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- same reason: one stat at a time keeps the descriptor count flat
          const info = await statSafe(path);
          if (info && fileMatches(path, info.size, options)) result.push(relative(root, path));
        }
      }
    }
    level = next;
  }
  return result;
}
