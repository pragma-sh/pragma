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
  workdir = mkdtempSync(join(tmpdir(), "pragma-kimi-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  // A fake `pragma-cli` on PATH that records its arguments, one call per line,
  // so the test can assert exactly which statuses report.sh emits.
  writeFileSync(
    join(binDir, "pragma-cli"),
    `#!/usr/bin/env sh\necho "$*" >> "$PRAGMA_TEST_LOG"\n`,
    {
      mode: 0o755,
    },
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** The marker file report.sh keys on PRAGMA_TAB_ID inside TMPDIR. */
function markerPath(): string {
  return join(tmpEnvDir, `pragma-cli-kimi-${TAB_ID}.active`);
}

/** The atomic subagent count file report.sh keeps inside TMPDIR. */
function subagentCountFile(): string {
  return join(tmpEnvDir, `pragma-cli-kimi-${TAB_ID}.subagents`);
}

/** The current tracked subagent count as report.sh sees it. */
function trackedSubagents(): number {
  if (!existsSync(subagentCountFile())) {
    return 0;
  }
  return Number(readFileSync(subagentCountFile(), "utf8").trim());
}

/** All pragma-cli invocations recorded so far, e.g. `agent report --agent kimi started`. */
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

/** Runs report.sh for one event and returns the pragma-cli calls it added. */
function run(
  event: string,
  {
    env: extraEnv = {},
    socket = true,
    stdin = "",
  }: { env?: Record<string, string>; socket?: boolean; stdin?: string } = {},
): string[] {
  const before = reportCalls();
  const runEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    // Isolate the kimi session-dir glob in `last_assistant_text` so transcript
    // lookups never touch the real `~/.kimi-code` on the test machine.
    HOME: workdir,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    ...extraEnv,
  };
  if (socket) {
    runEnv.PRAGMA_DAEMON_SOCKET = join(workdir, "daemon.sock");
  }
  execFileSync("sh", [REPORT_SH, event], { env: runEnv, input: stdin });
  return reportCalls().slice(before.length);
}

/** Whether a *working* `node` is on PATH (prompt/message parsing depends on it). */
const hasNode = (() => {
  try {
    execFileSync("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const itWithNode = hasNode ? it : it.skip;

/** Kimi's UserPromptSubmit stdin with a ContentPart array prompt. */
function promptStdin(text: string, sessionId = "session-parent"): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: [{ type: "text", text }],
    is_steer: false,
  });
}

describe("report.sh", () => {
  it("no-ops outside a Pragma terminal (no daemon socket)", () => {
    expect(run("started", { socket: false })).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("uses PRAGMA_CLI when it is set", () => {
    expect(
      run("started", {
        env: { PATH: process.env.PATH ?? "", PRAGMA_CLI: join(binDir, "pragma-cli") },
      }),
    ).toEqual(["agent report --agent kimi started"]);
  });

  it("reports started and marks the turn in flight", () => {
    expect(run("started", { stdin: promptStdin("Explain this repo") })).toContain(
      "agent report --agent kimi started",
    );
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithNode("surfaces the prompt as a user bubble and names the session once", () => {
    run("started", { stdin: promptStdin("Explain this repo", "session-a") });

    expect(messagePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "Explain this repo" }),
      ]),
    );
    expect(reportCalls()).toContain(
      "agent report --agent kimi session-name --name Explain this repo",
    );

    // Same session: no second rename.
    run("started", { stdin: promptStdin("Second prompt", "session-a") });
    expect(
      reportCalls().filter((line) => line.startsWith("agent report --agent kimi session-name")),
    ).toHaveLength(1);
  });

  it("reports a coarse started message when the prompt is empty or unparseable", () => {
    run("started", {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: [] }),
    });
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Kimi turn started" }),
    );
  });

  it("reports stopped and clears the in-flight marker on normal completion", () => {
    run("started", { stdin: promptStdin("hi") });
    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
      }),
    ).toEqual(["agent report --agent kimi stopped"]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("surfaces the turn's reply from the session transcript on Stop", () => {
    const sessionId = "session-reply";
    const transcriptDir = join(
      workdir,
      ".kimi-code",
      "sessions",
      "wd_test",
      sessionId,
      "agents",
      "main",
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "turn.prompt",
          input: [{ type: "text", text: "wait" }],
          time: 1,
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            part: { type: "think", think: "thinking..." },
          },
          time: 2,
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "content.part",
            part: { type: "text", text: "waiting" },
          },
          time: 3,
        }),
      ].join("\n"),
    );
    run("started", { stdin: promptStdin("wait", sessionId) });
    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
      }),
    ).toEqual(["agent report --agent kimi stopped"]);
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "waiting" }),
    );
  });

  it("does not report a phantom stopped dot without an in-flight turn", () => {
    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
      }),
    ).toEqual([]);
  });

  it("reports interrupted and clears the marker on user cancel (Esc/Ctrl+C)", () => {
    run("started", { stdin: promptStdin("hi") });
    expect(
      run("interrupted", {
        stdin: JSON.stringify({ hook_event_name: "Interrupt", turn_id: 1, reason: "cancelled" }),
      }),
    ).toEqual(["agent report --agent kimi cleared"]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports cleared on StopFailure", () => {
    run("started", { stdin: promptStdin("hi") });
    expect(
      run("failed", {
        stdin: JSON.stringify({
          hook_event_name: "StopFailure",
          error_type: "ProviderError",
          error_message: "rate limited",
        }),
      }),
    ).toEqual(["agent report --agent kimi cleared"]);
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "system", text: "Kimi turn failed (rate limited)" }),
    );
  });

  it("clears on SessionStart and forgets the pin and name on SessionEnd", () => {
    run("started", { stdin: promptStdin("hi", "session-a") });
    expect(run("cleared", { stdin: JSON.stringify({ hook_event_name: "SessionEnd" }) })).toEqual([
      "agent report --agent kimi cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("ignores a late SessionStart clear for a turn already owned by that session", () => {
    run("cleared", {
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "session-a",
        source: "startup",
      }),
    });
    run("started", { stdin: promptStdin("hi", "session-a") });

    expect(
      run("cleared", {
        stdin: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "session-a",
          source: "startup",
        }),
      }),
    ).toEqual([]);
    expect(existsSync(markerPath())).toBe(true);
  }, 10_000);

  it("rejects events from a different session", () => {
    run("cleared", {
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "session-a",
        source: "startup",
      }),
    });
    run("started", { stdin: promptStdin("hi", "session-a") });

    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session-b" }),
      }),
    ).toEqual([]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("stays running when Stop fires while a subagent is still tracked", () => {
    run("started", { stdin: promptStdin("hi") });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "Explore" }),
    });

    expect(
      run("stopped", {
        stdin: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
      }),
    ).toEqual(["agent report --agent kimi started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("tracks multiple subagents until the parent completes after the last child", () => {
    run("started", { stdin: promptStdin("hi") });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "Explore" }),
    });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "Code" }),
    });
    expect(trackedSubagents()).toBe(2);

    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_name: "Explore" }),
    });
    expect(trackedSubagents()).toBe(1);
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });
    expect(reportCalls()).not.toContain("agent report --agent kimi stopped");

    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_name: "Code" }),
    });
    expect(trackedSubagents()).toBe(0);
    run("stopped", { stdin: JSON.stringify({ hook_event_name: "Stop" }) });

    expect(reportCalls().at(-1)).toBe("agent report --agent kimi stopped");
  }, 10_000);

  it("counts parallel subagents that share the default profile name", () => {
    run("started", { stdin: promptStdin("hi") });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "coder" }),
    });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "coder" }),
    });
    // Kimi's parallel subagents all report `coder`; the count (not a per-name
    // marker) is what lets `subAgentsActive` reach 2 for verify's subagent
    // scenario.
    expect(trackedSubagents()).toBe(2);

    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_name: "coder" }),
    });
    expect(trackedSubagents()).toBe(1);
    run("subagent-stop", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStop", agent_name: "coder" }),
    });
    expect(trackedSubagents()).toBe(0);
  });

  it("keeps the tab running when a subagent fails but the parent still works", () => {
    run("started", { stdin: promptStdin("hi") });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "Explore" }),
    });

    expect(
      run("failed", {
        stdin: JSON.stringify({
          hook_event_name: "StopFailure",
          error_type: "ToolError",
          error_message: "subagent crashed",
        }),
      }),
    ).toEqual(["agent report --agent kimi started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("clears tracked subagents when the session ends", () => {
    run("started", { stdin: promptStdin("hi") });
    run("subagent-start", {
      stdin: JSON.stringify({ hook_event_name: "SubagentStart", agent_name: "Explore" }),
    });
    expect(trackedSubagents()).toBe(1);

    run("cleared", { stdin: JSON.stringify({ hook_event_name: "SessionEnd" }) });

    expect(trackedSubagents()).toBe(0);
  });

  it("re-asserts started on PostToolUse while a turn is in flight", () => {
    run("started", { stdin: promptStdin("hi") });
    expect(
      run("running", {
        stdin: JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/tmp/a.ts" },
          tool_call_id: "call-1",
        }),
      }),
    ).toEqual(["agent report --agent kimi started"]);
  });

  itWithNode("surfaces the tool output as an assistant message on PostToolUse", () => {
    run("started", { stdin: promptStdin("hi") });
    run("running", {
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "date +%s" },
        tool_call_id: "call-1",
        tool_output: "1785601397\n",
      }),
    });
    // stream-integrity / command-no-permission match assistant messages, and
    // PostToolUse is the only kimi hook that carries content, so the tool result
    // must land as an assistant message (not a user/system bubble).
    expect(messagePayloads()).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "1785601397" }),
    );
  });

  it("ignores PostToolUse outside a turn (no phantom running)", () => {
    expect(
      run("running", {
        stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }),
      }),
    ).toEqual([]);
  });

  itWithNode("raises a command attention on PermissionRequest", () => {
    run("started", { stdin: promptStdin("hi") });
    const raised = run("permission", {
      stdin: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
        action: "Call Bash",
      }),
    });
    // stream-integrity requires command attention to carry a request-id too.
    expect(
      raised.some((call) =>
        call.startsWith(
          "agent report --agent kimi attention --kind command --command npm run build --request-id ",
        ),
      ),
    ).toBe(true);
  });

  itWithNode("raises a question attention on AskUserQuestion PreToolUse", () => {
    run("started", { stdin: promptStdin("hi") });
    const raised = run("question", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which approach?",
              options: [{ label: "A", description: "First approach" }],
            },
          ],
        },
        tool_call_id: "call-1",
      }),
    });
    // stream-integrity requires question attention to carry text + request-id.
    expect(
      raised.some((call) =>
        call.startsWith(
          'agent report --agent kimi attention --kind question --question Which approach? --options [{"label":"A","description":"First approach"}] --request-id ',
        ),
      ),
    ).toBe(true);
  });

  itWithNode("does not send keys to a background question", () => {
    run("started", { stdin: promptStdin("hi") });
    const raised = run("question", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          background: true,
          questions: [{ question: "Later?", options: [{ label: "A" }] }],
        },
      }),
    });
    expect(raised).toEqual([]);
  });

  itWithNode("raises a generic question attention with text and a request-id", () => {
    run("started", { stdin: promptStdin("hi") });
    const raised = run("question", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ label: "A" }, { label: "B" }] },
      }),
    });
    expect(
      raised.some((call) =>
        call.startsWith(
          "agent report --agent kimi attention --kind question --question Kimi is asking a question --request-id ",
        ),
      ),
    ).toBe(true);
  });

  it("ignores permission/question attention outside a turn", () => {
    expect(
      run("permission", {
        stdin: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
      }),
    ).toEqual([]);
    expect(
      run("question", {
        stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
      }),
    ).toEqual([]);
  });
});
