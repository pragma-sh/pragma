/// <reference types="node" />

/**
 * `bun run benchmark` — builds the benchmark binary, then hands over to it.
 *
 * The measurement itself is Rust (see `src/main.rs`); this exists only because
 * the binary has to be built before it can be run, and because a stale build
 * would silently benchmark yesterday's payload. It is deliberately a launcher
 * and nothing else — no orchestration lives here.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Release, not debug: a debug ratatui payload adds its own redraw cost to every sample. */
const PROFILE = "release";

function run(command: string, args: string[]): void {
  const child = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    process.exit(child.status ?? 1);
  }
}

function main(): void {
  run("cargo", ["build", "--profile", PROFILE, "-p", "pragma-bench"]);
  run(join(repoRoot, "target", PROFILE, "pragma-bench"), ["run", ...process.argv.slice(2)]);
}

try {
  main();
} catch (error: unknown) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
