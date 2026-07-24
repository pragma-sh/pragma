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
  // and for `agent await-answer` $PRAGMA_TEST_ANSWER on stdout (empty by default
  // = timeout/no reply) so blocking approval/question paths can be exercised
  // without a real server.
  writeFileSync(
    fake,
    `#!/usr/bin/env sh\necho "$*" >> "$PRAGMA_TEST_LOG"\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\nif [ "$1 $2" = "agent await-answer" ]; then printf '%s' "\${PRAGMA_TEST_ANSWER:-}"; fi\n`,
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

function subagentDir(): string {
  return join(tmpEnvDir, `pragma-cli-claude-code-${TAB_ID}.subagents`);
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

/** Parsed payloads of every `agent message` call recorded so far. */
function messagePayloads(): Array<{ role: string; text: string }> {
  const flag = "--payload ";
  return calls()
    .filter((line) => line.startsWith("agent message "))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf(flag) + flag.length)) as {
          role: string;
          text: string;
        },
    );
}

describe("report.sh", () => {
  it("no-ops outside a Pragma terminal (no daemon socket)", () => {
    expect(run("started", { socket: false })).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it.each(["started", "stopped", "running", "permission", "attention", "idle", "cleared"])(
    "ignores %s hooks emitted inside a subagent",
    (event) => {
      expect(
        run(event, {
          stdin: JSON.stringify({
            hook_event_name: "Stop",
            agent_id: "agent-child-1",
            agent_type: "Explore",
          }),
        }),
      ).toEqual([]);
      expect(existsSync(markerPath())).toBe(false);
    },
  );

  it.each([
    { hook_event_name: "SubagentStop" },
    { hook_event_name: "Stop", agent_transcript_path: "/tmp/subagents/agent-child.jsonl" },
  ])("ignores subagent stop payload variants without agent_id", (payload) => {
    run("started");

    expect(run("stopped", { stdin: JSON.stringify(payload) })).toEqual([
      "agent report --agent claude-code started",
    ]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("ignores a plain Stop from a child session", () => {
    run("cleared", {
      stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "parent-session" }),
    });
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "parent-session" }),
    });

    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "child-session" }),
      }),
    ).toEqual([
      "agent report --agent claude-code cleared",
      "agent report --agent claude-code started",
    ]);
    expect(existsSync(markerPath())).toBe(true);

    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "parent-session" }),
      }),
    ).toEqual([
      "agent report --agent claude-code cleared",
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
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

  it("stays running when Stop fires while background subagents are active", () => {
    run("started");
    // The parent turn ended but a subagent is still working: Claude auto-resumes
    // when it finishes, so the session must NOT flip to the green done dot.
    expect(
      run("stopped", {
        stdin: JSON.stringify({
          hook_event_name: "Stop",
          last_assistant_message: "Agent searching. Standing by.",
          background_tasks: [
            { id: "a1", type: "subagent", status: "running", agent_type: "Explore" },
          ],
        }),
      }),
    ).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code started",
    ]);
    expect(existsSync(markerPath())).toBe(true);
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Agent searching. Standing by." }),
    );
  });

  it("tracks multiple subagents until the parent completes after the last child", () => {
    run("started");
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "child-1" }),
    });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "child-2" }),
    });
    expect(messagePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", subAgentsActive: 1 }),
        expect.objectContaining({ role: "system", subAgentsActive: 2 }),
      ]),
    );

    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "child-1" }),
    });
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });
    expect(reportCalls()).not.toContain("agent report --agent claude-code stopped");

    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "child-2" }),
    });
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });

    expect(reportCalls().at(-1)).toBe("agent report --agent claude-code stopped");
    expect(existsSync(subagentDir())).toBe(false);
  });

  it("clears tracked subagents when the Claude session ends", () => {
    run("started");
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "child-1" }),
    });
    expect(existsSync(subagentDir())).toBe(true);

    run("cleared", { stdin: JSON.stringify({ hook_event_name: "SessionEnd" }) });

    expect(existsSync(subagentDir())).toBe(false);
  });

  it("reports stopped normally when background tasks are done or not subagents", () => {
    run("started");
    expect(
      run("stopped", {
        stdin: JSON.stringify({
          hook_event_name: "Stop",
          background_tasks: [
            { id: "a1", type: "subagent", status: "completed" },
            { id: "b1", type: "bash", status: "running" },
          ],
        }),
      }),
    ).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("does not render a subagent task-notification as a user chat bubble", () => {
    run("started", {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "<task-notification>\n<task-id>a1</task-id>\n</task-notification>",
      }),
    });
    expect(messagePayloads()).not.toContainEqual(expect.objectContaining({ role: "user" }));
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({
        role: "system",
        text: "Claude Code resumed after a subagent finished",
      }),
    );
  });

  it("reports stopped and clears the in-flight marker on normal completion", () => {
    run("started");
    expect(run("stopped", { stdin: transcript([ASSISTANT_DONE]) })).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports finished after each consecutive agent turn", () => {
    run("started");
    run("stopped");
    run("started");
    run("stopped");

    expect(reportCalls()).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
    ]);
  });

  it("surfaces the user's prompt as a user chat message on started", () => {
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: 'Fix the "auth" bug' }),
    });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "user", text: 'Fix the "auth" bug' }),
    );
  });

  it("names the session from the first prompt, once per session", () => {
    const first = run("started", {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-a",
        prompt: "Fix flaky tests\nwith more detail",
      }),
    });
    expect(first).toContainEqual(expect.stringContaining("session-name --name Fix flaky tests"));

    // A second prompt in the same session must not rename again.
    const second = run("started", {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-a",
        prompt: "Now run the suite",
      }),
    });
    expect(second.filter((call) => call.includes("session-name"))).toHaveLength(1);
  });

  it("renames the tab when the session switches", () => {
    run("started", {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-a",
        prompt: "First session",
      }),
    });
    run("cleared", {
      stdin: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "session-a" }),
    });
    const afterSwitch = run("started", {
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-b",
        prompt: "Second session",
      }),
    });
    expect(afterSwitch).toContainEqual(
      expect.stringContaining("session-name --name Second session"),
    );
  });

  it("surfaces the transcript's assistant reply as a chat message on stopped", () => {
    run("started");
    run("stopped", { stdin: transcript([ASSISTANT_DONE]) });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "All done." }),
    );
  });

  it("surfaces Stop's assistant reply without requiring a transcript", () => {
    run("started");
    run("stopped", {
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "Implemented the fix.",
      }),
    });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Implemented the fix." }),
    );
    expect(messagePayloads()).not.toContainEqual(
      expect.objectContaining({ text: "Claude Code turn completed" }),
    );
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

  it.each([
    ["Read", { file_path: "src/config.ts" }, "Read src/config.ts"],
    [
      "Write",
      { file_path: "src/config.ts", content: "export const enabled = true;" },
      "Write src/config.ts",
    ],
    ["Read", JSON.stringify({ file_path: "src/config.ts" }), "Read src/config.ts"],
  ])("reports a file path instead of JSON for %s permissions", (toolName, toolInput, command) => {
    run("started");
    run("permission", {
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: toolName,
        tool_input: toolInput,
      }),
    });

    expect(reportCalls()[1]).toContain("attention --kind command");
    expect(reportCalls()[1]).toContain(`--command ${command}`);
    expect(reportCalls()[1]).toMatch(/--request-id claude-code-tab-test-/);
    expect(reportCalls()[1]).not.toContain(JSON.stringify(toolInput));
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

  it.each(["allow", "deny"])(
    "drops back to in progress after a %s verdict resumes the turn",
    (verdict) => {
      run("started");
      // A deny never runs the tool, so no PostToolUse follows -- the verdict
      // itself must restore the running status or the tab stays on attention.
      runRaw("permission", { stdin: PERMISSION_STDIN, env: { PRAGMA_TEST_DECISION: verdict } });
      expect(reportCalls().at(-1)).toBe("agent report --agent claude-code started");
      expect(existsSync(markerPath())).toBe(true);
    },
  );

  it("emits nothing (defers to Claude's own prompt) when no verdict arrives", () => {
    run("started");
    const output = runRaw("permission", { stdin: PERMISSION_STDIN });
    expect(output.trim()).toBe("");
  });

  const QUESTION = {
    question: "Which auth method should we use?",
    header: "Auth method",
    options: [{ label: "OAuth", description: "Redirect flow" }, { label: "API key" }],
    multiSelect: false,
  };
  const QUESTION_STDIN = JSON.stringify({
    hook_event_name: "PermissionRequest",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [QUESTION] },
  });

  it("reports a question attention (not a command) for AskUserQuestion", () => {
    run("started");
    run("permission", { stdin: QUESTION_STDIN });
    const reports = reportCalls();
    expect(reports[0]).toBe("agent report --agent claude-code started");
    expect(reports[1]).toContain("attention --kind question");
    expect(reports[1]).toContain("--question Which auth method should we use?");
    expect(reports[1]).toContain(
      '--options [{"label": "OAuth", "description": "Redirect flow"}, {"label": "API key"}]',
    );
    expect(reports[1]).toMatch(/--request-id claude-code-tab-test-/);
    expect(reports[1]).not.toContain("--kind command");
  });

  it("feeds a remote reply back as an allow decision with pre-filled answers", () => {
    run("started");
    const output = runRaw("permission", {
      stdin: QUESTION_STDIN,
      env: { PRAGMA_TEST_ANSWER: "OAuth" },
    });
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions: [QUESTION],
            answers: { "Which auth method should we use?": "OAuth" },
          },
        },
      },
    });
  });

  it("drops back to in progress after a remote reply resumes the turn", () => {
    run("started");
    // Answering restores the question tool's flow; nothing else is guaranteed
    // to report before the next tool finishes, so the reply itself must flip
    // the tab from the question attention back to running.
    runRaw("permission", { stdin: QUESTION_STDIN, env: { PRAGMA_TEST_ANSWER: "OAuth" } });
    expect(reportCalls().at(-1)).toBe("agent report --agent claude-code started");
    expect(existsSync(markerPath())).toBe(true);
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "system", text: "Question answered" }),
    );
  });

  it("drops back to in progress after a remote dismissal", () => {
    run("started");
    runRaw("permission", {
      stdin: QUESTION_STDIN,
      env: { PRAGMA_TEST_ANSWER: "__PRAGMA_QUESTION_DISMISSED__" },
    });
    expect(reportCalls().at(-1)).toBe("agent report --agent claude-code started");
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "system", text: "Question dismissed" }),
    );
  });

  it("denies a remotely dismissed question so Claude closes its native prompt", () => {
    run("started");
    const output = runRaw("permission", {
      stdin: QUESTION_STDIN,
      env: { PRAGMA_TEST_ANSWER: "__PRAGMA_QUESTION_DISMISSED__" },
    });
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
    expect(reportCalls()[1]).toContain("attention --kind question");
    const awaitCall = calls().find((call) => call.startsWith("agent await-answer "));
    expect(awaitCall).toContain(
      "agent await-answer --agent claude-code --request-id claude-code-tab-test-",
    );
    expect(awaitCall).toContain("--timeout 300 --dismiss-output __PRAGMA_QUESTION_DISMISSED__");
  });

  it("emits nothing (defers to Claude's question UI) when no answer arrives", () => {
    run("started");
    const output = runRaw("permission", { stdin: QUESTION_STDIN });
    expect(output.trim()).toBe("");
    // The question attention still went out so the tab shows the prompt.
    expect(reportCalls()[1]).toContain("--kind question");
  });

  it("falls back to a generic attention for multi-question payloads", () => {
    run("started");
    const stdin = JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [QUESTION, { ...QUESTION, question: "And the DB?" }] },
    });
    const output = runRaw("permission", { stdin });
    expect(output.trim()).toBe("");
    expect(reportCalls()).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code attention",
    ]);
  });

  it("ignores an AskUserQuestion request once the turn has ended", () => {
    expect(run("permission", { stdin: QUESTION_STDIN })).toEqual([]);
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

  it("keeps a live turn when its own session's SessionStart lands late (/clear race)", () => {
    // /clear fires SessionEnd + SessionStart while the user's next prompt may
    // already have started a turn in the NEW session. A late SessionStart must
    // not wipe that turn's marker -- doing so mutes every marker-guarded
    // report (attention, running) for the rest of the turn.
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-b" }),
    });
    expect(
      run("cleared", {
        stdin: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "session-b",
          source: "clear",
        }),
      }),
    ).toEqual(["agent report --agent claude-code started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("still clears on SessionStart when no turn of that session is in flight", () => {
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-a" }),
    });
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session-a" }) });
    expect(
      run("cleared", {
        stdin: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "session-b",
          source: "clear",
        }),
      }),
    ).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code stopped",
      "agent report --agent claude-code cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("discards the old session's late SessionEnd after a new session took over", () => {
    // Session pinning: once the new session reported, the old session's
    // trailing SessionEnd (fired by /clear) must not clear the new turn.
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-b" }),
    });
    expect(
      run("cleared", {
        stdin: JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: "session-a",
          reason: "clear",
        }),
      }),
    ).toEqual(["agent report --agent claude-code started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("reports cleared and removes the marker on session start/end", () => {
    run("started");
    const messagesBeforeClear = messagePayloads();
    expect(run("cleared")).toEqual([
      "agent report --agent claude-code started",
      "agent report --agent claude-code cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
    expect(messagePayloads()).toEqual(messagesBeforeClear);
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

    it("ignores the interrupt phrase embedded inside tool output", async () => {
      // A tool result that *contains* the marker text (e.g. Claude reading this
      // very script) arrives JSON-escaped inside another string. Only a real
      // top-level interrupt user message may clear the turn.
      const t = transcriptFile([ASSISTANT_DONE]);
      run("started", { stdin: t.stdin });
      const toolResult = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: 'grep -q "[Request interrupted by user" plus "text":"docs"',
            },
          ],
        },
        toolUseResult: { file: { content: INTERRUPTED } },
      });
      appendFileSync(t.path, `${toolResult}\n`);
      await sleep(400);
      expect(reportCalls()).toEqual(["agent report --agent claude-code started"]);
      expect(existsSync(markerPath())).toBe(true);
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
