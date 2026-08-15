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
  workdir = mkdtempSync(join(tmpdir(), "pragma-codex-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  writeFileSync(
    join(binDir, "pragma-cli"),
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$PRAGMA_TEST_LOG"\nif [ -n "\${TMPDIR:-}" ] && [ -n "\${PRAGMA_TAB_ID:-}" ] && [ -f "$TMPDIR/pragma-cli-codex-$PRAGMA_TAB_ID.watcher" ]; then printf 'watcher-running\\n' >> "$PRAGMA_TEST_LOG"; fi\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\n`,
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
  options: {
    env?: Record<string, string>;
    socket?: boolean;
    stdin?: string;
    args?: string[];
  } = {},
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
  execFileSync("sh", [REPORT_SH, event, ...(options.args ?? [])], {
    env,
    input: options.stdin ?? "",
  });
  return calls();
}

function runRaw(event: string, stdin: string, decision = ""): string {
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
    PRAGMA_SERVER_SOCKET: join(workdir, "server.sock"),
    PRAGMA_TEST_DECISION: decision,
  };
  return execFileSync("sh", [REPORT_SH, event], { env, input: stdin }).toString();
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

function markerPath(): string {
  return join(tmpEnvDir, `pragma-cli-codex-${TAB_ID}.active`);
}

function watcherPid(): number | undefined {
  const path = join(tmpEnvDir, `pragma-cli-codex-${TAB_ID}.watcher`);
  if (!existsSync(path)) {
    return undefined;
  }
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

function transcript(lines: object[] = []): { path: string; input: string } {
  const path = join(workdir, `rollout-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(
    path,
    lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : ""),
  );
  return {
    path,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-1",
      transcript_path: path,
      prompt: "Fix auth",
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The abort watcher polls in the background (PRAGMA_WATCH_INTERVAL=0.1s), so
// a fixed sleep before asserting on its output flakes under a loaded CI box.
// Poll for the expected state instead, capped by a generous timeout.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await sleep(20);
  }
}

/**
 * Whether a *working* `python3` is on PATH.
 *
 * `report.sh` parses content-bearing hook fields (prompt, transcript text,
 * questions) with Python 3 and treats it as optional, degrading to status-only
 * reporting without it. Assertions that depend on that parsing are therefore
 * conditional, or they fail on any host lacking it. Presence alone is not enough
 * to check: Windows ships an App Execution Alias named `python3` that only
 * prints "Python was not found", so this runs the interpreter.
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
    expect(run("cleared")).toContain("agent report --agent codex cleared");
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("reports normal turn start and stop with the fallback reply", () => {
    // No transcript_path: the assistant reply must come from the Stop
    // payload's last_assistant_message, delivered before the stopped report.
    run("started", { stdin: JSON.stringify({ turn_id: "turn-1", prompt: "Fix auth" }) });
    run("stopped", {
      stdin: JSON.stringify({ turn_id: "turn-1", last_assistant_message: "# Fixed\n\n- auth" }),
    });
    expect(reports()).toEqual([
      "agent report --agent codex started",
      "agent report --agent codex session-name --name Fix auth",
      "agent report --agent codex stopped",
    ]);
    expect(messages()).toEqual([
      expect.objectContaining({ id: "codex-turn-1-user", role: "user", text: "Fix auth" }),
      expect.objectContaining({
        id: "codex-turn-1-assistant",
        role: "assistant",
        text: "# Fixed\n\n- auth",
      }),
    ]);
    const stopIndex = calls().findIndex((call) => call.endsWith("stopped"));
    const replyIndex = calls().findIndex((call) => call.includes("codex-turn-1-assistant"));
    expect(replyIndex).toBeLessThan(stopIndex);
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("derives the session name from only the first prompt", () => {
    run("started", {
      stdin: JSON.stringify({ turn_id: "turn-1", prompt: "Fix auth\nwith regression tests" }),
    });
    run("stopped", { stdin: JSON.stringify({ turn_id: "turn-1" }) });
    run("started", { stdin: JSON.stringify({ turn_id: "turn-2", prompt: "Second turn" }) });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent codex session-name --name Fix auth",
    ]);
  });

  itWithPython3("marks a truncated session name with an ellipsis", () => {
    const prompt = "x".repeat(49);
    run("started", { stdin: JSON.stringify({ turn_id: "turn-1", prompt }) });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      `agent report --agent codex session-name --name ${"x".repeat(47)}…`,
    ]);
  });

  itWithPython3("derives a new session name after session clear", () => {
    run("started", { stdin: JSON.stringify({ turn_id: "turn-1", prompt: "First session" }) });
    run("cleared");
    run("started", { stdin: JSON.stringify({ turn_id: "turn-2", prompt: "Next session" }) });
    expect(reports().filter((call) => call.includes(" session-name "))).toEqual([
      "agent report --agent codex session-name --name First session",
      "agent report --agent codex session-name --name Next session",
    ]);
  });

  itWithPython3(
    "streams transcript assistant markdown during the turn and never duplicates it on stop",
    async () => {
      const current = transcript();
      run("started", { stdin: current.input });
      appendFileSync(
        current.path,
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "Interim: reading **files**." },
        })}\n`,
      );
      await waitFor(() => messages().length > 1);
      expect(messages().at(-1)).toEqual(
        expect.objectContaining({
          id: "codex-turn-1-assistant-000",
          role: "assistant",
          text: "Interim: reading **files**.",
        }),
      );
      expect(reports()).toEqual([
        "agent report --agent codex started",
        "agent report --agent codex session-name --name Fix auth",
      ]);

      // The final reply lands in the transcript just before Stop fires; the stop
      // handler must sync it (watcher may not have polled yet) exactly once and
      // must not re-send last_assistant_message through the fallback path.
      const reply = "# Result\n\n- one\n- two\n\n```bash\necho hi\n```";
      appendFileSync(
        current.path,
        `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: reply } })}\n`,
      );
      run("stopped", {
        stdin: JSON.stringify({
          turn_id: "turn-1",
          transcript_path: current.path,
          last_assistant_message: reply,
        }),
      });
      const assistant = messages().filter((message) => message.role === "assistant");
      expect(assistant).toEqual([
        expect.objectContaining({ id: "codex-turn-1-assistant-000" }),
        expect.objectContaining({ id: "codex-turn-1-assistant-001", text: reply }),
      ]);
      expect(reports().at(-1)).toBe("agent report --agent codex stopped");
    },
  );

  it("does not emit stopped without a prior start", () => {
    expect(run("stopped")).toEqual([]);
  });

  it("reasserts running after a tool completes", () => {
    run("started");
    run("running");
    expect(reports()).toEqual([
      "agent report --agent codex started",
      "agent report --agent codex started",
    ]);
  });

  itWithPython3("tracks subagents so parent stop cannot finish early", () => {
    run("started");
    run("subagent-start", { stdin: JSON.stringify({ agent_id: "child-1" }) });
    expect(messages()).toContainEqual(
      expect.objectContaining({
        role: "system",
        text: "Codex started a subagent",
        subAgentsActive: 1,
      }),
    );
    run("stopped");
    expect(reports()).not.toContain("agent report --agent codex stopped");
    expect(existsSync(markerPath())).toBe(true);

    run("subagent-stop", { stdin: JSON.stringify({ agent_id: "child-1" }) });
    run("stopped");
    expect(reports().at(-1)).toBe("agent report --agent codex stopped");
  });

  itWithPython3("reports command attention and returns allow", () => {
    run("started");
    const output = runRaw(
      "permission",
      JSON.stringify({
        turn_id: "turn-1",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      }),
      "allow",
    );
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(reports()[1]).toMatch(
      /^agent report --agent codex attention --kind command --command Bash bun test --request-id codex-/,
    );
    expect(reports().at(-1)).toBe("agent report --agent codex started");
  });

  it("returns deny with a reason", () => {
    run("started");
    const output = runRaw(
      "permission",
      JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "patch" } }),
      "deny",
    );
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied from Pragma" },
      },
    });
  });

  it("defers to native approval UI after timeout", () => {
    run("started");
    const output = runRaw(
      "permission",
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "bun test" } }),
    );
    expect(output).toBe("");
  });

  itWithPython3("reports a transcript question and resumes after its answer", async () => {
    const current = transcript();
    run("started", { stdin: current.input });
    appendFileSync(
      current.path,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call-question-1",
          arguments: JSON.stringify({
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Choose Red or Blue?",
                options: [
                  { label: "Red", description: "Warm" },
                  { label: "Blue", description: "Cool" },
                ],
              },
            ],
          }),
        },
      })}\n`,
    );
    await waitFor(() => reports().at(-1)?.includes(" attention ") ?? false);
    expect(reports().at(-1)).toBe(
      'agent report --agent codex attention --kind question --question Choose Red or Blue? --options [{"label":"Red","description":"Warm"},{"label":"Blue","description":"Cool"}] --request-id call-question-1',
    );

    appendFileSync(
      current.path,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-question-1",
          output: JSON.stringify({ answers: { color: { answers: ["Red"] } } }),
        },
      })}\n`,
    );
    await waitFor(() => reports().at(-1) === "agent report --agent codex started");
    expect(reports().at(-1)).toBe("agent report --agent codex started");
  });

  itWithPython3("reports multi-question requests as one attention with --questions", async () => {
    const current = transcript();
    run("started", { stdin: current.input });
    appendFileSync(
      current.path,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call-multi",
          arguments: JSON.stringify({
            questions: [
              { id: "one", question: "First?", options: [{ label: "A" }] },
              { id: "two", question: "Second?", options: [{ label: "B" }] },
            ],
          }),
        },
      })}\n`,
    );
    await waitFor(() => reports().at(-1)?.includes(" attention ") ?? false);
    expect(reports().at(-1)).toBe(
      'agent report --agent codex attention --kind question --questions [{"question":"First?","options":[{"label":"A"}]},{"question":"Second?","options":[{"label":"B"}]}] --request-id call-multi',
    );
  });

  itWithPython3("abort watcher clears current turn", async () => {
    const current = transcript();
    run("started", { stdin: current.input });
    appendFileSync(
      current.path,
      `${JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } })}\n`,
    );
    await waitFor(() => reports().at(-1) === "agent report --agent codex cleared");
    expect(reports()).toEqual([
      "agent report --agent codex started",
      "agent report --agent codex session-name --name Fix auth",
      "agent report --agent codex cleared",
    ]);
    expect(existsSync(markerPath())).toBe(false);
  });

  itWithPython3("abort watcher ignores a prior turn marker", async () => {
    const current = transcript([{ type: "event_msg", payload: { type: "turn_aborted" } }]);
    run("started", { stdin: current.input });
    await sleep(350);
    expect(reports()).toEqual([
      "agent report --agent codex started",
      "agent report --agent codex session-name --name Fix auth",
    ]);
    expect(existsSync(markerPath())).toBe(true);
  });

  itWithPython3("starts the abort watcher before reporting running", () => {
    const current = transcript();
    run("started", { stdin: current.input });
    const log = calls();
    // The watcher must be spawned before the slow pragma-cli reports: Codex
    // kills the in-flight UserPromptSubmit hook when a turn is aborted, so a
    // watcher started only at the end of the handler never runs for a fast
    // abort and the `turn_aborted` marker is never scanned.
    const firstReport = log.indexOf("agent report --agent codex started");
    expect(firstReport).toBeGreaterThanOrEqual(0);
    expect(log[firstReport + 1]).toBe("watcher-running");
  });
});
