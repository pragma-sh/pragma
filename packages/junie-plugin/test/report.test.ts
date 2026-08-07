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
const SESSION_ID = "session-260806-104937-1ja5";

let workdir: string;
let binDir: string;
let tmpEnvDir: string;
let junieHome: string;
let logPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pragma-junie-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  junieHome = join(workdir, "junie-home");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  mkdirSync(join(junieHome, "sessions", SESSION_ID), { recursive: true });
  // Records every call; for `agent await-decision` it prints $PRAGMA_TEST_DECISION
  // on stdout (empty by default, i.e. the timeout path).
  writeFileSync(
    join(binDir, "pragma-cli"),
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$PRAGMA_TEST_LOG"\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  const pid = watcherPid();
  if (pid !== undefined) {
    try {
      process.kill(pid);
    } catch {
      // Watcher already exited.
    }
  }
  rmSync(workdir, { recursive: true, force: true });
});

function run(
  event: string,
  options: { env?: Record<string, string>; socket?: boolean; stdin?: string } = {},
): string {
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    HOME: workdir,
    JUNIE_HOME: junieHome,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    PRAGMA_WATCH_INTERVAL: "0.1",
    PRAGMA_APPROVAL_TIMEOUT: "1",
    ...options.env,
  };
  if (options.socket !== false) {
    env.PRAGMA_SERVER_SOCKET = join(workdir, "server.sock");
  }
  return execFileSync("sh", [REPORT_SH, event], {
    env,
    input: options.stdin ?? "",
    encoding: "utf8",
  });
}

function calls(): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

function reports(): string[] {
  return calls().filter((call) => call.startsWith("agent report "));
}

function messages(): Array<{ id: string; role: string; text: string }> {
  return calls()
    .filter((call) => call.startsWith("agent message "))
    .map((call) => JSON.parse(call.slice(call.indexOf("--payload ") + "--payload ".length)));
}

function statePath(suffix: string): string {
  return join(tmpEnvDir, `pragma-cli-junie-${TAB_ID}.${suffix}`);
}

function markerPath(): string {
  return statePath("active");
}

function watcherPid(): number | undefined {
  const path = statePath("watcher");
  if (!existsSync(path)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

/** One `events.jsonl` record in the shape Junie persists. */
function agentEvent(event: object): string {
  return JSON.stringify({
    kind: "SessionA2uxEvent",
    event: { state: "IN_PROGRESS", agentEvent: { agent: { kind: "MainAgent" }, ...event } },
    timestampMs: 1786038579298,
  });
}

function eventsPath(): string {
  return join(junieHome, "sessions", SESSION_ID, "events.jsonl");
}

function writeEvents(lines: string[]): void {
  writeFileSync(eventsPath(), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function appendEvents(lines: string[]): void {
  appendFileSync(eventsPath(), `${lines.join("\n")}\n`);
}

/** The `AskAsyncRequestUpdatedEvent` Junie writes when it blocks on a question. */
function ask(status: string): string {
  return agentEvent({
    kind: "AskAsyncRequestUpdatedEvent",
    stepId: "step-1",
    title: "Which database?",
    request: {
      id: "req-1",
      name: "database-choice",
      question: "Which database?",
      options: [
        { id: "Postgres", title: "Postgres", description: "Relational." },
        { id: "SQLite", title: "SQLite" },
      ],
      isRequired: false,
    },
    status,
  });
}

function startPayload(prompt: string): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    prompt,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The abort watcher polls in the background (PRAGMA_WATCH_INTERVAL=0.1s), so a
// fixed sleep before asserting flakes on a loaded box. Poll instead.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    // oxlint-disable-next-line no-await-in-loop -- polling is intentionally serial.
    await sleep(20);
  }
}

/**
 * Whether a *working* `python3` is on PATH. `report.sh` parses content-bearing
 * hook fields with it and degrades to status-only reporting without it, so
 * assertions that depend on that parsing are conditional. Presence alone is not
 * enough: Windows ships an App Execution Alias named `python3` that only prints
 * "Python was not found", so this runs the interpreter.
 */
const hasPython3 = (() => {
  try {
    execFileSync("python3", ["-c", ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const itWithPython3 = hasPython3 ? it : it.skip;

describe("report.sh", () => {
  it("no-ops outside Pragma", () => {
    run("started", { socket: false });
    expect(calls()).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("asks rather than staying silent for a permission request outside Pragma", () => {
    // Junie reads a hook that exits 0 with no decision as an approval, so the
    // no-socket no-op must not apply to PermissionRequest.
    const stdout = run("permission", {
      socket: false,
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    });
    expect(JSON.parse(stdout)).toMatchObject({ decision: "ask" });
    expect(calls()).toEqual([]);
  });

  it("asks rather than staying silent for a permission request with no turn", () => {
    // Inside Pragma but with no in-flight turn (no marker), the hook must still
    // not auto-approve through silence.
    const stdout = run("permission", {
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    });
    expect(JSON.parse(stdout)).toMatchObject({ decision: "ask" });
  });

  it("clears stale state on session start", () => {
    run("started", { stdin: startPayload("hi") });
    run("cleared", {
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "other",
        source: "startup",
      }),
    });
    expect(reports()).toContain("agent report --agent junie cleared");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("reports a normal turn and delivers the reply before done", () => {
    run("started", { stdin: startPayload("Fix auth") });
    run("stopped", {
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "# Fixed\n\n- auth",
      }),
    });
    expect(reports()).toEqual([
      "agent report --agent junie started",
      "agent report --agent junie session-name --name Fix auth",
      "agent report --agent junie stopped",
    ]);
    const stopIndex = calls().findIndex((call) => call.endsWith("stopped"));
    const replyIndex = calls().findIndex((call) => call.includes('"role": "assistant"'));
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeLessThan(stopIndex);
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("prefers Junie's own generated task name over the prompt", () => {
    writeEvents([agentEvent({ kind: "AgentTaskNameUpdatedEvent", name: "Repair the auth flow" })]);
    run("started", { stdin: startPayload("fix it") });
    expect(reports()).toContain(
      "agent report --agent junie session-name --name Repair the auth flow",
    );
  });

  itWithPython3("renames only when the task name changes", () => {
    writeEvents([agentEvent({ kind: "AgentTaskNameUpdatedEvent", name: "First title" })]);
    run("started", { stdin: startPayload("one") });
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });
    run("started", { stdin: startPayload("two") });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent junie session-name --name First title",
    ]);
  });

  itWithPython3("marks a truncated derived session name with an ellipsis", () => {
    const prompt = "x".repeat(49);
    run("started", { stdin: startPayload(prompt) });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      `agent report --agent junie session-name --name ${"x".repeat(47)}…`,
    ]);
  });

  it("never reports done without an active turn", () => {
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });
    expect(reports()).toEqual([]);
  });

  it("clears rather than completing a turn that failed", () => {
    run("started", { stdin: startPayload("hi") });
    run("failed", {
      stdin: JSON.stringify({
        hook_event_name: "StopFailure",
        error: "rate_limit",
        error_details: "429",
      }),
    });
    expect(reports()).toContain("agent report --agent junie cleared");
    expect(reports()).not.toContain("agent report --agent junie stopped");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("re-asserts running when a tool starts mid-turn", () => {
    run("started", { stdin: startPayload("hi") });
    run("pre-tool", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    });
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(2);
    expect(messages().at(-1)).toMatchObject({ role: "tool", text: "ls -la" });
  });

  it("ignores a tool call outside a turn", () => {
    run("pre-tool", {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    });
    expect(reports()).toEqual([]);
  });

  itWithPython3("ignores the submit tool that precedes Stop", () => {
    run("started", { stdin: startPayload("hi") });
    run("pre-tool", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "submit",
        tool_input: { solution_summary: "done" },
      }),
    });
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(1);
  });

  itWithPython3("never re-asserts running for Junie's question tools", () => {
    run("started", { stdin: startPayload("hi") });
    run("pre-tool", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "ask_user_choice",
        tool_input: { message: "Which database?" },
      }),
    });
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(1);
  });

  itWithPython3("raises a question attention from the event log", async () => {
    writeEvents([]);
    run("started", { stdin: startPayload("hi") });
    appendEvents([ask("IN_PROGRESS")]);
    await waitFor(() => reports().some((call) => call.includes("--kind question")));
    const attention = reports().find((call) => call.includes("--kind question"));
    expect(attention).toContain("--question Which database?");
    expect(attention).toContain('"label": "Postgres"');
    expect(attention).toContain("--request-id junie-tab-test-req-1");
  });

  itWithPython3("drops back to running once Junie's question resolves", async () => {
    writeEvents([]);
    run("started", { stdin: startPayload("hi") });
    appendEvents([ask("IN_PROGRESS")]);
    await waitFor(() => reports().some((call) => call.includes("--kind question")));
    appendEvents([ask("COMPLETED")]);
    await waitFor(() => reports().filter((call) => call.endsWith("started")).length > 1);
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(2);
    // The attention is raised exactly once for one question, however often the
    // watcher polls.
    expect(reports().filter((call) => call.includes("--kind question"))).toHaveLength(1);
  });

  itWithPython3("approves a permission request from a Pragma verdict", () => {
    run("started", { stdin: startPayload("hi") });
    const stdout = run("permission", {
      env: { PRAGMA_TEST_DECISION: "allow" },
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    });
    expect(JSON.parse(stdout)).toMatchObject({ decision: "allow" });
    const attention = reports().find((call) => call.includes("--kind command"));
    expect(attention).toContain("--command rm -rf build");
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(2);
  });

  itWithPython3("denies a permission request from a Pragma verdict", () => {
    run("started", { stdin: startPayload("hi") });
    const stdout = run("permission", {
      env: { PRAGMA_TEST_DECISION: "deny" },
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      }),
    });
    expect(JSON.parse(stdout)).toMatchObject({ decision: "deny" });
  });

  itWithPython3("falls back to Junie's own prompt when nobody decides", () => {
    run("started", { stdin: startPayload("hi") });
    const stdout = run("permission", {
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
    });
    // Silence would auto-approve in Junie, so the timeout must ask explicitly.
    expect(JSON.parse(stdout)).toMatchObject({ decision: "ask" });
  });

  itWithPython3("clears a cancelled turn the event log records", async () => {
    writeEvents([agentEvent({ kind: "AgentTaskNameUpdatedEvent", name: "T" })]);
    run("started", { stdin: startPayload("hi") });
    appendEvents([agentEvent({ kind: "ResultBlockUpdatedEvent", cancelled: true, result: "" })]);
    await waitFor(() => reports().some((call) => call.endsWith("cleared")));
    expect(reports()).toContain("agent report --agent junie cleared");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("ignores a cancel recorded before this turn started", async () => {
    writeEvents([agentEvent({ kind: "ResultBlockUpdatedEvent", cancelled: true, result: "" })]);
    run("started", { stdin: startPayload("hi") });
    await sleep(400);
    expect(reports()).not.toContain("agent report --agent junie cleared");
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithPython3("streams the assistant reply while the turn runs", async () => {
    writeEvents([]);
    run("started", { stdin: startPayload("hi") });
    appendEvents([
      agentEvent({ kind: "MarkdownBlockUpdatedEvent", stepId: "s1", text: "Working" }),
    ]);
    await waitFor(() => messages().some((entry) => entry.role === "assistant"));
    appendEvents([
      agentEvent({ kind: "MarkdownBlockUpdatedEvent", stepId: "s1", text: "Working on it now" }),
    ]);
    await waitFor(() =>
      messages().some((entry) => entry.role === "assistant" && entry.text === "Working on it now"),
    );
    const assistant = messages().filter((entry) => entry.role === "assistant");
    // A block is replaced, not appended, and every update reuses one stable id.
    expect(assistant.at(-1)?.text).toBe("Working on it now");
    expect(new Set(assistant.map((entry) => entry.id)).size).toBe(1);
  });

  itWithPython3("keeps an in-flight turn when its own session start lands late", () => {
    run("started", { stdin: startPayload("hi") });
    run("cleared", {
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: SESSION_ID,
        source: "startup",
      }),
    });
    expect(reports()).not.toContain("agent report --agent junie cleared");
    expect(existsSync(markerPath())).toBe(true);
  });

  it("forgets the session on SessionEnd", () => {
    run("started", { stdin: startPayload("hi") });
    run("cleared", { stdin: JSON.stringify({ hook_event_name: "SessionEnd", reason: "other" }) });
    expect(reports()).toContain("agent report --agent junie cleared");
    expect(existsSync(statePath("session"))).toBe(false);
  });
});
