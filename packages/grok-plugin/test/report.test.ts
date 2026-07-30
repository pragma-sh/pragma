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
  workdir = mkdtempSync(join(tmpdir(), "pragma-grok-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  writeFileSync(
    join(binDir, "pragma-cli"),
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$PRAGMA_TEST_LOG"\n`,
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
): string[] {
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    PRAGMA_WATCH_INTERVAL: "0.1",
    ...options.env,
  };
  if (options.socket !== false) {
    env.PRAGMA_SERVER_SOCKET = join(workdir, "server.sock");
  }
  execFileSync("sh", [REPORT_SH, event], { env, input: options.stdin ?? "" });
  return calls();
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

function messages(): Array<{ id: string; role: string; text: string; subAgentsActive: number }> {
  return calls()
    .filter((call) => call.startsWith("agent message "))
    .map((call) => JSON.parse(call.slice(call.indexOf("--payload ") + "--payload ".length)));
}

function statePath(suffix: string): string {
  return join(tmpEnvDir, `pragma-cli-grok-${TAB_ID}.${suffix}`);
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

/** One `updates.jsonl` record in the shape grok persists. */
function update(sessionUpdate: object): string {
  return JSON.stringify({
    timestamp: 1785374586,
    method: "session/update",
    params: { sessionId: "s1", update: sessionUpdate },
  });
}

function chunk(text: string): string {
  return update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function turnCompleted(stopReason: string): string {
  return update({ sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: stopReason });
}

/**
 * Creates a grok session directory: the transcript plus the `signals.json` and
 * `summary.json` siblings `report.sh` reads for cancellations and the title.
 */
function session(options: { lines?: string[]; cancellations?: number; title?: string } = {}): {
  transcriptPath: string;
  signalsPath: string;
} {
  const dir = mkdtempSync(join(workdir, "session-"));
  const transcriptPath = join(dir, "updates.jsonl");
  const lines = options.lines ?? [];
  writeFileSync(transcriptPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  const signalsPath = join(dir, "signals.json");
  writeFileSync(signalsPath, JSON.stringify({ cancellationCount: options.cancellations ?? 0 }));
  if (options.title !== undefined) {
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: options.title }));
  }
  return { transcriptPath, signalsPath };
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
    expect(run("started", { socket: false })).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("clears stale state on session start", () => {
    run("started");
    expect(run("cleared")).toContain("agent report --agent grok cleared");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("reports a normal turn and delivers the reply before done", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "Fix auth" }),
    });
    run("stopped", {
      stdin: JSON.stringify({
        hookEventName: "stop",
        reason: "end_turn",
        lastAssistantMessage: "# Fixed\n\n- auth",
      }),
    });
    expect(reports()).toEqual([
      "agent report --agent grok started",
      "agent report --agent grok session-name --name Fix auth",
      "agent report --agent grok stopped",
    ]);
    const stopIndex = calls().findIndex((call) => call.endsWith("stopped"));
    const replyIndex = calls().findIndex((call) => call.includes('"role": "assistant"'));
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeLessThan(stopIndex);
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("strips grok's <user_query> envelope from the prompt", () => {
    run("started", {
      stdin: JSON.stringify({
        hookEventName: "user_prompt_submit",
        prompt: "<user_query>\nFix auth\n</user_query>",
      }),
    });
    expect(messages()).toEqual([expect.objectContaining({ role: "user", text: "Fix auth" })]);
    expect(reports()).toContain("agent report --agent grok session-name --name Fix auth");
  });

  itWithPython3("prefers grok's own generated session title over the prompt", () => {
    const { transcriptPath } = session({ title: "Repair the auth flow" });
    run("started", {
      stdin: JSON.stringify({
        hookEventName: "user_prompt_submit",
        prompt: "fix it",
        transcriptPath,
      }),
    });
    expect(reports()).toContain(
      "agent report --agent grok session-name --name Repair the auth flow",
    );
  });

  itWithPython3("renames only when the session title changes", () => {
    const { transcriptPath } = session({ title: "First title" });
    const stdin = JSON.stringify({
      hookEventName: "user_prompt_submit",
      prompt: "one",
      transcriptPath,
    });
    run("started", { stdin });
    run("stopped", {
      stdin: JSON.stringify({ hookEventName: "stop", reason: "end_turn", transcriptPath }),
    });
    run("started", { stdin });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent grok session-name --name First title",
    ]);
  });

  itWithPython3("marks a truncated derived session name with an ellipsis", () => {
    const prompt = "x".repeat(49);
    run("started", { stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt }) });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      `agent report --agent grok session-name --name ${"x".repeat(47)}…`,
    ]);
  });

  itWithPython3("ignores the observe-only Stop grok fires at session end", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("stopped", { stdin: JSON.stringify({ hookEventName: "stop", reason: "shutdown" }) });
    expect(reports()).not.toContain("agent report --agent grok stopped");
    expect(existsSync(markerPath())).toBe(true);
  });

  it("never reports done without an active turn", () => {
    run("stopped", { stdin: JSON.stringify({ hookEventName: "stop", reason: "end_turn" }) });
    expect(reports()).toEqual([]);
  });

  itWithPython3("stays running while subagents are still working", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("stopped", {
      stdin: JSON.stringify({
        hookEventName: "stop",
        reason: "end_turn",
        backgroundTasks: [{ id: "t1", type: "subagent", status: "running" }],
      }),
    });
    expect(reports()).not.toContain("agent report --agent grok stopped");
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(2);
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithPython3("tracks overlapping subagents by id", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("subagent-start", {
      stdin: JSON.stringify({ hookEventName: "subagent_start", agentId: "a" }),
    });
    run("subagent-start", {
      stdin: JSON.stringify({ hookEventName: "subagent_start", agentId: "b" }),
    });
    run("subagent-stop", {
      stdin: JSON.stringify({ hookEventName: "subagent_stop", agentId: "a" }),
    });
    run("stopped", { stdin: JSON.stringify({ hookEventName: "stop", reason: "end_turn" }) });
    expect(reports()).not.toContain("agent report --agent grok stopped");
    run("subagent-stop", {
      stdin: JSON.stringify({ hookEventName: "subagent_stop", agentId: "b" }),
    });
    run("stopped", { stdin: JSON.stringify({ hookEventName: "stop", reason: "end_turn" }) });
    expect(reports()).toContain("agent report --agent grok stopped");
  });

  itWithPython3("clears when grok's cancellation counter grows", async () => {
    const { transcriptPath, signalsPath } = session({ cancellations: 2 });
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    expect(reports()).not.toContain("agent report --agent grok cleared");
    writeFileSync(signalsPath, JSON.stringify({ cancellationCount: 3 }));
    await waitFor(() => reports().includes("agent report --agent grok cleared"));
    expect(reports()).toContain("agent report --agent grok cleared");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("clears on a non-end_turn turn_completed record", async () => {
    const { transcriptPath } = session();
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    appendFileSync(transcriptPath, `${turnCompleted("cancelled")}\n`);
    await waitFor(() => reports().includes("agent report --agent grok cleared"));
    expect(reports()).toContain("agent report --agent grok cleared");
  });

  itWithPython3("keeps the whole streamed reply instead of Stop's last message", () => {
    // Grok emits one assistant message per tool round and `lastAssistantMessage`
    // is only the final one, so trusting it would replace the turn's reply with
    // its last sentence.
    const { transcriptPath } = session();
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    writeFileSync(transcriptPath, `${chunk("Running the command. ")}\n${chunk("DONE")}\n`);
    run("stopped", {
      stdin: JSON.stringify({
        hookEventName: "stop",
        reason: "end_turn",
        transcriptPath,
        lastAssistantMessage: "DONE",
      }),
    });
    const assistant = messages().filter((message) => message.role === "assistant");
    expect(assistant.at(-1)?.text).toBe("Running the command. DONE");
  });

  itWithPython3("appends a closing message grok flushed after firing Stop", () => {
    // Observed live on 0.2.114: Stop runs before the last `agent_message_chunk`
    // reaches `updates.jsonl`, so the transcript alone loses the closing text.
    const { transcriptPath } = session();
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    writeFileSync(transcriptPath, `${chunk("Running the command. ")}\n`);
    run("stopped", {
      stdin: JSON.stringify({
        hookEventName: "stop",
        reason: "end_turn",
        transcriptPath,
        lastAssistantMessage: "DONE",
      }),
    });
    const assistant = messages().filter((message) => message.role === "assistant");
    expect(assistant.at(-1)?.text).toBe("Running the command. DONE");
  });

  itWithPython3("ignores a previous turn's cancel record", async () => {
    // The cancel record is already the transcript's last line when the new turn
    // starts, so a whole-file scan would clear a turn that is merely thinking.
    const { transcriptPath } = session({ lines: [turnCompleted("cancelled")], cancellations: 1 });
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    await sleep(400);
    expect(reports()).not.toContain("agent report --agent grok cleared");
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithPython3("does not clear a turn that completes normally", async () => {
    const { transcriptPath } = session();
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    appendFileSync(transcriptPath, `${turnCompleted("end_turn")}\n`);
    await sleep(400);
    expect(reports()).not.toContain("agent report --agent grok cleared");
  });

  itWithPython3("streams assistant chunks under one stable per-turn id", async () => {
    const { transcriptPath } = session();
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi", transcriptPath }),
    });
    appendFileSync(transcriptPath, `${chunk("Hello")}\n`);
    await waitFor(() => messages().some((message) => message.text === "Hello"));
    appendFileSync(transcriptPath, `${chunk(" world")}\n`);
    await waitFor(() => messages().some((message) => message.text === "Hello world"));
    const streamed = messages().filter((message) => message.role === "assistant");
    expect(streamed.map((message) => message.text)).toEqual(["Hello", "Hello world"]);
    expect(new Set(streamed.map((message) => message.id)).size).toBe(1);
  });

  itWithPython3("re-asserts running after a tool finishes mid-turn", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("running", {
      stdin: JSON.stringify({
        hookEventName: "post_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command: "bun test" },
      }),
    });
    expect(reports().filter((call) => call.endsWith("started"))).toHaveLength(2);
    expect(messages()).toContainEqual(expect.objectContaining({ role: "tool", text: "bun test" }));
  });

  it("ignores a stray tool event outside a turn", () => {
    expect(run("running", { stdin: JSON.stringify({ hookEventName: "post_tool_use" }) })).toEqual(
      [],
    );
  });

  itWithPython3("raises attention for a question and clears it on the tool result", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("question", {
      stdin: JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "ask_user_question",
        toolInput: { questions: [{ question: "Which database?" }] },
      }),
    });
    expect(reports()).toContain("agent report --agent grok attention");
    expect(messages()).toContainEqual(
      expect.objectContaining({ role: "system", text: "Which database?" }),
    );
    run("running", {
      stdin: JSON.stringify({ hookEventName: "post_tool_use", toolName: "ask_user_question" }),
    });
    expect(reports().at(-1)).toBe("agent report --agent grok started");
  });

  itWithPython3("clears rather than completing a turn that failed on an API error", () => {
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", prompt: "hi" }),
    });
    run("failed", {
      stdin: JSON.stringify({ hookEventName: "stop_failure", error: "rate_limit" }),
    });
    expect(reports()).toContain("agent report --agent grok cleared");
    expect(reports()).not.toContain("agent report --agent grok stopped");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("drops events belonging to another session", () => {
    run("started", {
      stdin: JSON.stringify({
        hookEventName: "user_prompt_submit",
        sessionId: "parent",
        prompt: "hi",
      }),
    });
    run("stopped", {
      stdin: JSON.stringify({ hookEventName: "stop", sessionId: "child", reason: "end_turn" }),
    });
    expect(reports()).not.toContain("agent report --agent grok stopped");
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithPython3("keeps a turn that already started in the session being started", () => {
    // `/new` fires SessionStart while the first prompt of that same session may
    // already be in flight; a late clear must not mute the rest of the turn.
    run("started", {
      stdin: JSON.stringify({ hookEventName: "user_prompt_submit", sessionId: "s1", prompt: "hi" }),
    });
    run("cleared", { stdin: JSON.stringify({ hookEventName: "session_start", sessionId: "s1" }) });
    expect(reports()).not.toContain("agent report --agent grok cleared");
    expect(existsSync(markerPath())).toBe(true);
  });
});
