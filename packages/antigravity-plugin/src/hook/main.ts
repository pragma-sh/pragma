// Entry point of `agy-plugin/dist/hook.mjs`, run by `hooks/report.sh` with the
// hook event name as argv[2] and agy's JSON payload on stdin.
//
// Fail-open by construction: the wrapper has already printed agy's verdict,
// this process never writes stdout, and every failure here is swallowed so a
// broken Pragma connection can never disturb an agy session.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecord } from "../json";
import { emptyState, handleHook, type HookState, type TurnReading } from "./handle";
import { latestTurn, parseTranscript } from "./transcript";

/** How long one `pragma-cli` call may take before it is abandoned. */
const CLI_TIMEOUT_MS = 5000;
/** A lock older than this was left by a killed hook and is broken. */
const STALE_LOCK_MS = 10_000;
/** Total time to wait for the tab lock before giving up on this event. */
const LOCK_WAIT_MS = 4000;
const LOCK_POLL_MS = 25;

function main(): void {
  const base = statePrefix();
  const lock = `${base}.lock`;
  if (!acquire(lock)) return;
  try {
    // Run while holding the lock: parallel sub-agent hooks must not reorder
    // one tab's reports.
    for (const args of applyEvent(`${base}.json`)) runCli(args);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Per-tab state file prefix under the temp directory. */
function statePrefix(): string {
  const tab = sanitize(process.env.PRAGMA_TAB_ID ?? "unknown");
  return join(process.env.TMPDIR ?? tmpdir(), `pragma-cli-antigravity-${tab}`);
}

/** Runs the state machine for this event, persists its state, returns its commands. */
function applyEvent(statePath: string): string[][] {
  const result = handleHook({
    event: process.argv[2] ?? "",
    payload: parseRecord(readStdin()) ?? {},
    state: readState(statePath),
    tab: process.env.PRAGMA_TAB_ID ?? "unknown",
    readTurn,
    now: Date.now(),
  });
  writeFileSync(statePath, JSON.stringify(result.state));
  return result.commands;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readState(path: string): HookState {
  try {
    return { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<HookState>) };
  } catch {
    return emptyState();
  }
}

function readTurn(path: string): TurnReading | null {
  try {
    return latestTurn(parseTranscript(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function runCli(args: string[]): void {
  try {
    spawnSync(process.env.PRAGMA_CLI || "pragma-cli", ["agent", ...args], {
      stdio: "ignore",
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // Reporting is best effort.
  }
}

/** `mkdir` is atomic, so it doubles as a cross-process mutex. */
function acquire(lock: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      breakStale(lock);
      sleep(LOCK_POLL_MS);
    }
  }
  return false;
}

function breakStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
      rmSync(lock, { recursive: true, force: true });
    }
  } catch {
    // Already released.
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

try {
  main();
} catch {
  // Never disturb the agy session.
}
