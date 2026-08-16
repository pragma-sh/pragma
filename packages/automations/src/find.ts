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

interface FindWaveResult {
  files: string[];
  directories: string[];
}

function inspectDirectory(path: string, entry: Dirent): FindWaveResult {
  return {
    files: [],
    directories: FIND_SKIP_DIRS.has(entry.name) ? [] : [path],
  };
}

async function inspectFile(
  root: string,
  path: string,
  entry: Dirent,
  options: FindOptions,
): Promise<FindWaveResult> {
  if (!entry.isFile() || (options.name !== undefined && entry.name !== options.name)) {
    return { files: [], directories: [] };
  }
  if (options.minBytes === undefined) {
    return { files: [relative(root, path)], directories: [] };
  }
  const info = await statSafe(path);
  return {
    files: info && fileMatches(path, info.size, options) ? [relative(root, path)] : [],
    directories: [],
  };
}

async function inspectEntry(
  root: string,
  directory: string,
  entry: Dirent,
  options: FindOptions,
): Promise<FindWaveResult> {
  const path = join(directory, entry.name);
  if (entry.isSymbolicLink()) return { files: [], directories: [] };
  return entry.isDirectory()
    ? inspectDirectory(path, entry)
    : inspectFile(root, path, entry, options);
}

async function inspectWave(
  root: string,
  wave: string[],
  options: FindOptions,
): Promise<FindWaveResult> {
  const result: FindWaveResult = { files: [], directories: [] };
  const listings = await Promise.all(wave.map((directory) => readdirSafe(directory)));
  for (const [index, entries] of listings.entries()) {
    const directory = wave[index];
    if (directory === undefined) continue;
    for (const entry of entries) {
      // Serial stats keep descriptor use flat even inside a concurrent directory wave.
      // eslint-disable-next-line no-await-in-loop
      const inspected = await inspectEntry(root, directory, entry, options);
      result.files.push(...inspected.files);
      result.directories.push(...inspected.directories);
    }
  }
  return result;
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
      const inspected = await inspectWave(root, wave, options);
      result.push(...inspected.files);
      next.push(...inspected.directories);
    }
    level = next;
  }
  return result;
}
