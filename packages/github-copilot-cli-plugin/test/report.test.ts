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
let tempDir: string;
let logPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pragma-github-copilot-hook-"));
  binDir = join(workdir, "bin");
  tempDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    join(binDir, "pragma-cli"),
    `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "$PRAGMA_TEST_LOG"\nif [ "$1 $2" = "agent await-decision" ]; then printf '%s' "\${PRAGMA_TEST_DECISION:-}"; fi\n`,
    { mode: 0o755 },
  );
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function run(event: string, stdin = "", decision = "", socket = true, args: string[] = []): string {
  return execFileSync("sh", [REPORT_SH, event, ...args], {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: workdir,
      TMPDIR: tempDir,
      PRAGMA_TAB_ID: TAB_ID,
      PRAGMA_TEST_LOG: logPath,
      PRAGMA_TEST_DECISION: decision,
      PRAGMA_WATCH_INTERVAL: "0.1",
      PRAGMA_WATCH_MAX: "0",
      ...(socket ? { PRAGMA_SERVER_SOCKET: join(workdir, "server.sock") } : {}),
    },
    input: stdin,
  }).toString();
}

function calls(): string[] {
  return existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

function parallelChild(timestamp: number): string {
  return JSON.stringify({
    transcriptPath: "/tmp/shared.jsonl",
    agentName: "explore",
    agentDisplayName: "Explore",
    timestamp,
  });
}

describe("report.sh", () => {
  it("no-ops outside Pragma", () => {
    run("started", JSON.stringify({ prompt: "Fix auth" }), "", false);
    expect(calls()).toEqual([]);
  });

  it("reports start, session name, messages, and normal stop", () => {
    const transcript = join(workdir, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "assistant.message", data: { content: "Fixed auth." } })}\n`,
    );
    run("started", JSON.stringify({ sessionId: "session-1", timestamp: 100, prompt: "Fix auth" }));
    run("stopped", JSON.stringify({ transcriptPath: transcript }));
    expect(calls()).toEqual([
      "agent report --agent github-copilot started",
      "agent report --agent github-copilot session-name --name Fix auth",
      expect.stringContaining(
        'agent message --agent github-copilot --payload {"id":"github-copilot-session-1|100-user"',
      ),
      expect.stringContaining(
        'agent message --agent github-copilot --payload {"id":"github-copilot-session-1|100-assistant-0"',
      ),
      "agent report --agent github-copilot stopped",
    ]);
  });

  it("never reports stopped without started", () => {
    run("stopped");
    expect(calls()).toEqual([]);
  });

  it("does not clear a turn when sessionStart arrives late", () => {
    run("started", JSON.stringify({ sessionId: "session-1", timestamp: 1, prompt: "Hi" }));
    run("session-start", JSON.stringify({ sessionId: "session-1", timestamp: 2 }));
    run("stopped");
    expect(calls().at(-1)).toBe("agent report --agent github-copilot stopped");
    expect(calls()).not.toContain("agent report --agent github-copilot cleared");
  });

  it("returns remote command decisions and resumes running", () => {
    run("started", JSON.stringify({ sessionId: "s", timestamp: 1, prompt: "Run tests" }));
    const output = run(
      "permission",
      JSON.stringify({
        sessionId: "s",
        timestamp: 2,
        toolName: "bash",
        toolArgs: { command: "bun test" },
      }),
      "allow",
    );
    expect(JSON.parse(output)).toEqual({ behavior: "allow" });
    expect(calls()).toContainEqual(
      expect.stringMatching(
        /^agent report --agent github-copilot attention --kind command --command bash bun test --request-id github-copilot-/,
      ),
    );
    expect(calls().at(-1)).toBe("agent report --agent github-copilot started");
  });

  it("defers safe read-only commands to Copilot without false attention", () => {
    run("started", JSON.stringify({ sessionId: "s", timestamp: 1, prompt: "Get time" }));
    const before = calls().length;
    const output = run(
      "permission",
      JSON.stringify({
        sessionId: "s",
        timestamp: 2,
        toolName: "bash",
        toolInput: { command: "date +%s" },
      }),
    );
    expect(output).toBe("");
    expect(calls()).toHaveLength(before);
  });

  it("keeps parent running while subagents remain active", () => {
    run("started", JSON.stringify({ sessionId: "s", timestamp: 1, prompt: "Delegate" }));
    const child = JSON.stringify({
      transcriptPath: "/tmp/child-1.jsonl",
      agentName: "explore",
      agentDisplayName: "Explore",
    });
    run("subagent-start", child);
    run("stopped");
    expect(calls()).not.toContain("agent report --agent github-copilot stopped");
    run("subagent-stop", child);
    run("stopped");
    expect(calls().at(-1)).toBe("agent report --agent github-copilot stopped");
  });

  it("counts same-type parallel sub-agents separately", () => {
    run("started", JSON.stringify({ sessionId: "s", timestamp: 1, prompt: "Delegate" }));
    run("subagent-start", parallelChild(2));
    run("subagent-start", parallelChild(3));
    const messages = calls().filter((call) => call.includes("agent message"));
    expect(messages.at(-1)).toContain('"subAgentsActive":2');
    run("stopped");
    expect(calls()).not.toContain("agent report --agent github-copilot stopped");
    run("subagent-stop", parallelChild(4));
    run("subagent-stop", parallelChild(5));
    run("stopped");
    expect(calls().at(-1)).toBe("agent report --agent github-copilot stopped");
  });

  it("reports a transcript free-form ask_user as a question once", () => {
    const transcript = join(workdir, "questions.jsonl");
    const token = "session-1|100";
    writeFileSync(`${tempDir}/pragma-cli-github-copilot-${TAB_ID}.active`, token);
    writeFileSync(`${tempDir}/pragma-cli-github-copilot-${TAB_ID}.questions`, "0");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "call-free-form",
          toolName: "ask_user",
          arguments: {
            message: "Provide a short response.",
            requestedSchema: {
              properties: {
                response: { type: "string", title: "Response", minLength: 1 },
              },
              required: ["response"],
            },
          },
        },
      })}\n`,
    );

    run("__watch", "", "", true, [transcript, token]);
    run("__watch", "", "", true, [transcript, token]);

    expect(calls()).toEqual([
      "agent report --agent github-copilot attention --kind question --question Provide a short response. --request-id call-free-form",
    ]);
  });

  it("includes enum choices when reporting a transcript ask_user", () => {
    const transcript = join(workdir, "questions.jsonl");
    const token = "session-1|100";
    writeFileSync(`${tempDir}/pragma-cli-github-copilot-${TAB_ID}.active`, token);
    writeFileSync(`${tempDir}/pragma-cli-github-copilot-${TAB_ID}.questions`, "0");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "tool.execution_start",
        data: {
          toolCallId: "call-choice",
          toolName: "ask_user",
          arguments: {
            message: "Choose a color.",
            requestedSchema: {
              properties: {
                color: { type: "string", enum: ["Red", "Blue"] },
              },
              required: ["color"],
            },
          },
        },
      })}\n`,
    );

    run("__watch", "", "", true, [transcript, token]);

    expect(calls()).toEqual([
      'agent report --agent github-copilot attention --kind question --question Choose a color. --options [{"label":"Red"},{"label":"Blue"}] --request-id call-choice',
    ]);
  });
});
