import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPORT_SH = fileURLToPath(new URL("../hooks/report.sh", import.meta.url));
const TAB_ID = "tab-test";

let workdir: string;
let binDir: string;
let tmpEnvDir: string;
let logPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pragma-claude-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  // A fake `pragma-cli` on PATH that records its arguments, one call per line,
  // so the test can assert exactly which statuses report.sh emits.
  const fake = join(binDir, "pragma-cli");
  // Records every call; for `agent await-decision` it prints $PRAGMA_TEST_DECISION
  // on stdout (empty by default = timeout/no verdict) so the blocking approval
  // path can be exercised without a real server.
  writeFileSync(
    fake,
    `#!/usr/bin/env sh\necho "$*" >> "$PRAGMA_TEST_LOG"\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  // Tear down any watcher a test left running before deleting its state files.
  const pid = watcherPid();
  if (pid !== undefined) {
    try {
      process.kill(pid);
    } catch {
      // Already exited — nothing to clean up.
    }
  }
  rmSync(workdir, { recursive: true, force: true });
});

/** The marker file report.sh keys on PRAGMA_TAB_ID inside TMPDIR. */
function markerPath(): string {
  return join(tmpEnvDir, `pragma-cli-claude-code-${TAB_ID}.active`);
}

/** Runs report.sh for one event and returns the recorded pragma-cli calls. */
function run(
  event: string,
  {
    env: extraEnv = {},
    socket = true,
    stdin = "",
    args = [],
  }: { env?: Record<string, string>; socket?: boolean; stdin?: string; args?: string[] } = {},
): string[] {
  const runEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    // Poll fast so the background watcher's behavior is observable within a test.
    PRAGMA_WATCH_INTERVAL: "0.1",
    ...extraEnv,
  };
  if (socket) {
    runEnv.PRAGMA_DAEMON_SOCKET = join(workdir, "daemon.sock");
  }
  execFileSync("sh", [REPORT_SH, event, ...args], { env: runEnv, input: stdin });
  return reportCalls();
}

/** Runs report.sh and returns its stdout (the PermissionRequest decision JSON). */
function runRaw(
  event: string,
  {
    env: extraEnv = {},
    socket = true,
    stdin = "",
  }: { env?: Record<string, string>; socket?: boolean; stdin?: string } = {},
): string {
  const runEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    PRAGMA_WATCH_INTERVAL: "0.1",
    ...extraEnv,
  };
  if (socket) {
    runEnv.PRAGMA_DAEMON_SOCKET = join(workdir, "daemon.sock");
  }
  return execFileSync("sh", [REPORT_SH, event], { env: runEnv, input: stdin }).toString();
}

/** The pid of the watcher report.sh spawned for the current tab, if any. */
function watcherPid(): number | undefined {
  const path = join(tmpEnvDir, `pragma-cli-claude-code-${TAB_ID}.watcher`);
  if (!existsSync(path)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

/** Resolves after `ms`, long enough for the fast-polling watcher to react. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes a transcript file and returns its path plus the stdin JSON a hook
 * delivers for it, so a test can later append an interrupt line to that same
 * file to simulate a cancel the watcher must notice.
 */
function transcriptFile(lines: string[]): { path: string; stdin: string } {
  const path = join(workdir, `live-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
  return {
    path,
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", transcript_path: path }),
  };
}

/**
 * Writes a transcript JSONL file and returns the stdin JSON a Claude Code hook
 * would deliver for it (only `transcript_path` matters to report.sh).
 */
function transcript(lines: string[]): string {
  const path = join(workdir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return JSON.stringify({ hook_event_name: "Stop", transcript_path: path });
}

const ASSISTANT_DONE = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
});
const INTERRUPTED = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
});
const INTERRUPTED_TOOL = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
  },
});

/** All pragma-cli invocations recorded so far, e.g. `agent report --agent claude-code started`. */
function calls(): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

/** Only `agent report` calls — filters out `agent message` calls (those carry non-deterministic ids/ts). */
function reportCalls(): string[] {
  return calls().filter((line) => line.startsWith("agent report "));
}

describe("report.sh", () => {
  it("no-ops outside a Pragma terminal (no daemon socket)", () => {
    expect(run("started", { socket: false })).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports started and marks the turn in flight", () => {
    expect(run("started")).toEqual(["agent report --agent claude-code started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("uses PRAGMA_CLI when it is set", () => {
    expect(
      run("started", {
        env: { PATH: process.env.PATH ?? "", PRAGMA_CLI: join(binDir, "pragma-cli") },
      }),
    ).toEqual(["agent report --agent claude-code started"]);
  });

  it("reports stopped and clears the in-flight marker on normal completion", () => {
    run("started");
    expect(run("stopped", { stdin: transcript([ASSISTANT_DONE]) })).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports stopped when Stop carries no transcript (older Claude Code)", () => {
    run("started");
    expect(run("stopped")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("clears instead of stopping when the turn ended in an ESC abort", () => {
    run("started");
    // Stop fires after an interrupt; the transcript's trailing user message is
    // the abort marker -> drop the indicator rather than leave a green done dot.
    expect(run("stopped", { stdin: transcript([ASSISTANT_DONE, INTERRUPTED]) })).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("clears on a tool-use abort marker too", () => {
    run("started");
    expect(run("stopped", { stdin: transcript([ASSISTANT_DONE, INTERRUPTED_TOOL]) })).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code cleared",
    ]);
  });

  it("does not treat an interrupt from a prior completed turn as an abort", () => {
    run("started");
    // An abort happened mid-turn, but the turn continued and completed normally,
    // so the marker is no longer in the transcript tail -> still a done dot.
    const old = Array.from({ length: 8 }, () => ASSISTANT_DONE);
    expect(run("stopped", { stdin: transcript([INTERRUPTED, ...old]) })).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
  });

  it("clears via idle when a turn's marker still exists (defensive fallback)", () => {
    run("started");
    // `idle_prompt` does NOT fire after a real cancel (the watcher handles those);
    // this only guards a hypothetical build that emits idle with the marker still
    // present -> treat it as a turn that never ended and clear the stuck indicator.
    expect(run("idle")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("leaves a completed turn's done state intact on idle (no marker)", () => {
    run("started");
    run("stopped");
    // Idle after a normal completion must NOT clear the green done dot.
    expect(run("idle")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
  });

  it("reports a generic attention for permission/elicitation prompts in flight", () => {
    run("started");
    expect(run("attention")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code attention",
    ]);
  });

  it("ignores an attention report once the turn has ended (defense-in-depth)", () => {
    // The marker is gone (turn finished/cancelled); a late or stray attention
    // must NOT land on an already-finished turn that nothing would clear.
    expect(run("attention")).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  const PERMISSION_STDIN = JSON.stringify({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });

  it("reports a command attention with the command and a requestId on PermissionRequest", () => {
    run("started");
    run("permission", { stdin: PERMISSION_STDIN });
    const reports = reportCalls();
    expect(reports[0]).toBe("agent report --agent claude-code started");
    expect(reports[1]).toMatch(
      /^agent report --agent claude-code attention --kind command --command .+ --request-id claude-code-tab-test-/,
    );
  });

  it("ignores a PermissionRequest once the turn has ended", () => {
    expect(run("permission", { stdin: PERMISSION_STDIN })).toEqual([]);
  });

  it("emits Claude's allow decision when the toast approves", () => {
    run("started");
    const output = runRaw("permission", {
      stdin: PERMISSION_STDIN,
      env: { PRAGMA_TEST_DECISION: "allow" },
    });
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("emits Claude's deny decision when the toast denies", () => {
    run("started");
    const output = runRaw("permission", {
      stdin: PERMISSION_STDIN,
      env: { PRAGMA_TEST_DECISION: "deny" },
    });
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  it("emits nothing (defers to Claude's own prompt) when no verdict arrives", () => {
    run("started");
    const output = runRaw("permission", { stdin: PERMISSION_STDIN });
    expect(output.trim()).toBe("");
  });

  it("re-asserts running after a tool completes so approved-prompt attention clears", () => {
    run("started");
    // A permission prompt put the tab on `attention`; approving it fires no hook,
    // but the tool's PostToolUse does -> we report running again at once.
    run("attention");
    expect(run("running")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code attention",
      "agent report --agent claude-code started",
    ]);
    // Same turn: the marker and its abort watcher must survive.
    expect(existsSync(markerPath())).toBe(true);
  });

  it("ignores PostToolUse outside a turn (no marker)", () => {
    // No turn in flight -> a stray PostToolUse must not flash a phantom running.
    expect(run("running")).toEqual([]);
  });

  it("reports cleared and removes the marker on session start/end", () => {
    run("started");
    expect(run("cleared")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  // Cancelling a turn (ESC abort / reject command / decline question) fires no
  // Claude Code hook, so `started` spawns a background watcher that polls the
  // transcript for the interrupt marker and clears the stuck indicator itself.
  describe("abort watcher", () => {
    it("clears the indicator when a turn is cancelled with no hook", async () => {
      const t = transcriptFile([ASSISTANT_DONE]);
      expect(run("started", { stdin: t.stdin })).toEqual([
        "agent report --agent claude-code started",
      ]);
      expect(watcherPid()).toBeDefined();
      // The cancel surfaces only in the transcript, never as a hook.
      appendFileSync(t.path, `${INTERRUPTED}\n`);
      await sleep(600);
      expect(reportCalls()).toEqual([
        "agent report --agent claude-code started",
        "agent report --agent claude-code cleared",
      ]);
      expect(existsSync(markerPath())).toBe(false);
    });

    it("ignores a prior turn's interrupt marker while the new turn is thinking", async () => {
      // The transcript already ends with a cancelled turn's interrupt marker.
      // A new turn starts on that same file; while Claude is still thinking it
      // has appended nothing, so the stale marker must NOT trigger a clear.
      const t = transcriptFile([ASSISTANT_DONE, INTERRUPTED]);
      run("started", { stdin: t.stdin });
      await sleep(400);
      expect(reportCalls()).toEqual(["agent report --agent claude-code started"]);
      expect(existsSync(markerPath())).toBe(true);
    });

    it("still clears when the new turn is itself cancelled after a stale marker", async () => {
      const t = transcriptFile([ASSISTANT_DONE, INTERRUPTED]);
      run("started", { stdin: t.stdin });
      // This turn's own cancel is appended past where the watcher was pinned.
      appendFileSync(t.path, `${INTERRUPTED}\n`);
      await sleep(400);
      expect(reportCalls()).toEqual([
        "agent report --agent claude-code started",
        "agent report --agent claude-code cleared",
      ]);
      expect(existsSync(markerPath())).toBe(false);
    });

    it("does not clear when the turn completes normally", async () => {
      const t = transcriptFile([ASSISTANT_DONE]);
      run("started", { stdin: t.stdin });
      // `Stop` ends the turn and tears the watcher down.
      run("stopped");
      await sleep(600);
      // A late transcript line must not resurrect a clear after a normal end.
      appendFileSync(t.path, `${INTERRUPTED}\n`);
      await sleep(300);
      expect(reportCalls()).toEqual([
        "agent report --agent claude-code started",
        "agent report --agent claude-code stopped",
      ]);
    });

    it("a new turn supersedes the prior watcher", async () => {
      const first = transcriptFile([ASSISTANT_DONE]);
      run("started", { stdin: first.stdin });
      const second = transcriptFile([ASSISTANT_DONE]);
      run("started", { stdin: second.stdin });
      // Cancelling the *old* turn must not clear: its watcher was replaced.
      appendFileSync(first.path, `${INTERRUPTED}\n`);
      await sleep(600);
      expect(reportCalls()).toEqual([
        "agent report --agent claude-code started",
        "agent report --agent claude-code started",
      ]);
      expect(existsSync(markerPath())).toBe(true);
    });

    it("ignores a turn it no longer owns (token mismatch)", () => {
      // Marker belongs to a different turn than the watcher was spawned for.
      writeFileSync(markerPath(), "other-token");
      const t = transcriptFile([ASSISTANT_DONE, INTERRUPTED]);
      expect(run("__watch", { args: [t.path, "stale-token"] })).toEqual([]);
      // The owning turn's marker is left untouched.
      expect(existsSync(markerPath())).toBe(true);
    });

    it("clears via the watcher when its own turn was cancelled", () => {
      writeFileSync(markerPath(), "my-token");
      const t = transcriptFile([ASSISTANT_DONE, INTERRUPTED]);
      expect(run("__watch", { args: [t.path, "my-token"] })).toEqual([
        "agent report --agent claude-code cleared",
      ]);
      expect(existsSync(markerPath())).toBe(false);
    });
  });
});
