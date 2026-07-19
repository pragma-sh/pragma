import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  workdir = mkdtempSync(join(tmpdir(), "pragma-cursor-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  const fake = join(binDir, "pragma-cli");
  // Logs every call; for `agent await-decision` it prints $PRAGMA_TEST_DECISION
  // on stdout (empty by default = timeout/no verdict) so the hook can be driven.
  writeFileSync(
    fake,
    `#!/usr/bin/env sh\necho "$*" >> "$PRAGMA_TEST_LOG"\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function markerPath(): string {
  return join(tmpEnvDir, `pragma-cli-cursor-${TAB_ID}.active`);
}

function run(
  event: string,
  {
    env = {},
    socket = true,
    stdin = "",
  }: { env?: Record<string, string>; socket?: boolean; stdin?: string } = {},
): string[] {
  runRaw(event, { env, socket, stdin });
  return reportCalls();
}

/** Runs report.sh and returns its stdout (the harness-specific decision JSON). */
function runRaw(
  event: string,
  {
    env = {},
    socket = true,
    stdin = "",
  }: { env?: Record<string, string>; socket?: boolean; stdin?: string } = {},
): string {
  const runEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    ...env,
  };
  if (socket) {
    runEnv.PRAGMA_DAEMON_SOCKET = join(workdir, "daemon.sock");
  }
  return execFileSync("sh", [REPORT_SH, event], { env: runEnv, input: stdin }).toString();
}

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

function messagePayloads(): Array<{ role: string; text: string }> {
  const flag = "--payload ";
  return calls()
    .filter((line) => line.startsWith("agent message "))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf(flag) + flag.length)) as { role: string; text: string },
    );
}

describe("cursor report.sh", () => {
  it("no-ops outside Pragma", () => {
    run("started", { socket: false });
    expect(reportCalls()).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports started and sets marker", () => {
    run("started");
    expect(reportCalls()).toEqual(["agent report --agent cursor started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("surfaces the submitted prompt as a user message", () => {
    run("started", { stdin: JSON.stringify({ prompt: 'Fix the "auth" bug' }) });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "user", text: 'Fix the "auth" bug' }),
    );
  });

  it("derives the session name from only the first prompt", () => {
    run("started", { stdin: JSON.stringify({ prompt: "Fix auth\nwith regression tests" }) });
    run("stopped");
    run("started", { stdin: JSON.stringify({ prompt: "Second turn" }) });
    expect(reportCalls().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent cursor session-name --name Fix auth",
    ]);
  });

  it("derives a new session name after session clear", () => {
    run("started", { stdin: JSON.stringify({ prompt: "First session" }) });
    run("cleared");
    run("started", { stdin: JSON.stringify({ prompt: "Next session" }) });
    expect(reportCalls().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent cursor session-name --name First session",
      "agent report --agent cursor session-name --name Next session",
    ]);
  });

  it("uses PRAGMA_CLI when it is set", () => {
    run("started", {
      env: { PATH: process.env.PATH ?? "", PRAGMA_CLI: join(binDir, "pragma-cli") },
    });
    expect(reportCalls()).toEqual(["agent report --agent cursor started"]);
  });

  it("reports stopped and clears marker", () => {
    run("started");
    run("stopped");
    expect(reportCalls()).toEqual([
      "agent report --agent cursor started",
      "agent report --agent cursor stopped",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("surfaces agent responses as assistant messages", () => {
    run("started");
    run("response", { stdin: JSON.stringify({ text: "Implemented the fix." }) });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Implemented the fix." }),
    );
  });

  it.each(["aborted", "error"])("clears an %s turn instead of reporting completion", (status) => {
    run("started");
    run("stopped", { stdin: JSON.stringify({ status }) });
    expect(reportCalls()).toEqual([
      "agent report --agent cursor started",
      "agent report --agent cursor cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports cleared", () => {
    run("started");
    const messagesBeforeClear = messagePayloads();
    run("cleared");
    expect(reportCalls()).toEqual([
      "agent report --agent cursor started",
      "agent report --agent cursor cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
    expect(messagePayloads()).toEqual(messagesBeforeClear);
  });

  it("reports command attention with command + requestId only during a turn", () => {
    run("attention-command");
    expect(reportCalls()).toEqual([]);
    run("started");
    run("attention-command", { stdin: '{"command":"npm test"}' });
    const reports = reportCalls();
    expect(reports[0]).toBe("agent report --agent cursor started");
    expect(reports[1]).toMatch(
      /^agent report --agent cursor attention --kind command --command npm test --request-id cursor-/,
    );
  });

  it("emits Cursor's allow decision when the toast approves", () => {
    run("started");
    const output = runRaw("attention-command", {
      stdin: '{"command":"npm test"}',
      env: { PRAGMA_TEST_DECISION: "allow" },
    });
    expect(output.trim()).toBe('{"permission":"allow"}');
  });

  it("emits Cursor's deny decision when the toast denies", () => {
    run("started");
    const output = runRaw("attention-command", {
      stdin: '{"command":"npm test"}',
      env: { PRAGMA_TEST_DECISION: "deny" },
    });
    expect(output.trim()).toBe('{"permission":"deny"}');
  });

  it("defers to Cursor's own prompt (no output) when no verdict arrives", () => {
    run("started");
    const output = runRaw("attention-command", { stdin: '{"command":"npm test"}' });
    expect(output.trim()).toBe("");
  });

  it("re-asserts running after attention via running", () => {
    run("started");
    run("attention-command", { stdin: '{"command":"npm test"}' });
    run("running");
    const reports = reportCalls();
    expect(reports[0]).toBe("agent report --agent cursor started");
    expect(reports[2]).toBe("agent report --agent cursor started");
  });
});
