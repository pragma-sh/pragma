import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  reportAttention: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportCleared: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportMessage: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionName: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStarted: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStopped: vi.fn((..._args: unknown[]) => Promise.resolve({})),
}));

function forwardReportMock(mock: (...args: unknown[]) => Promise<object>) {
  return (...args: unknown[]) => mock(...args);
}

vi.mock("@pragma/sdk", () => {
  return {
    hasPragmaEnvironment: (env: Record<string, string | undefined>) =>
      ["PRAGMA_GATEWAY_URL", "PRAGMA_GATEWAY_TOKEN", "PRAGMA_TAB_ID", "PRAGMA_WORKTREE_ID"].every(
        (key) => Boolean(env[key]),
      ),
    reportAttention: forwardReportMock(sdkMocks.reportAttention),
    reportCleared: forwardReportMock(sdkMocks.reportCleared),
    reportMessage: forwardReportMock(sdkMocks.reportMessage),
    reportSessionName: forwardReportMock(sdkMocks.reportSessionName),
    reportStarted: forwardReportMock(sdkMocks.reportStarted),
    reportStopped: forwardReportMock(sdkMocks.reportStopped),
  };
});

import { createPragmaOpencodeHooks } from "./hooks";
import PragmaOpencodePlugin from "./index";

type Report = "started" | "stopped" | "cleared" | `attention:${string}`;

const pragmaEnv = {
  PRAGMA_GATEWAY_URL: "http://127.0.0.1:1234",
  PRAGMA_GATEWAY_TOKEN: "token",
  PRAGMA_DAEMON_SOCKET: "/tmp/pragma.sock",
  PRAGMA_TAB_ID: "tab-1",
  PRAGMA_WORKTREE_ID: "worktree-1",
};

function testHooks() {
  const reports: Report[] = [];
  const sessionNames: string[] = [];
  const commands: string[] = [];
  const questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    requestId: string;
  }> = [];
  const messages: Array<{
    id: string;
    role: string;
    text?: string;
    toolCalls?: Array<{ name: string; summary?: string }>;
    subAgentsActive?: number;
  }> = [];
  const hooks = createPragmaOpencodeHooks({
    env: pragmaEnv,
    async started() {
      reports.push("started");
    },
    async stopped() {
      reports.push("stopped");
    },
    async attention(kind) {
      reports.push(`attention:${kind}`);
    },
    async message(message) {
      messages.push({
        id: message.id,
        role: message.role,
        ...(message.text ? { text: message.text } : {}),
        ...(message.toolCalls
          ? {
              toolCalls: message.toolCalls.map((call) => ({
                name: call.name,
                ...(call.summary ? { summary: call.summary } : {}),
              })),
            }
          : {}),
        ...(message.subAgentsActive > 0 ? { subAgentsActive: message.subAgentsActive } : {}),
      });
    },
    async cleared() {
      reports.push("cleared");
    },
    async attentionCommand(command) {
      reports.push("attention:command");
      commands.push(command);
    },
    async attentionQuestion(question, options, requestId) {
      reports.push("attention:question");
      questions.push({ question, options, requestId });
    },
    async attentionQuestions(entries, requestId) {
      reports.push("attention:question");
      for (const entry of entries) {
        questions.push({ question: entry.question, options: entry.options ?? [], requestId });
      }
    },
    async sessionName(name) {
      sessionNames.push(name);
    },
  });
  return { hooks, reports, commands, questions, messages, sessionNames };
}

function runtimeEvent(type: string, properties: Record<string, unknown>) {
  return { event: { type, properties } as never };
}

function sessionStatus(type: "busy" | "idle" | "retry") {
  const status =
    type === "retry" ? { type, attempt: 1, message: "rate limited", next: 0 } : { type };
  return runtimeEvent("session.status", { sessionID: "s1", status });
}

function questionPart(status: string) {
  return runtimeEvent("message.part.updated", {
    part: {
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      callID: "c1",
      tool: "question",
      state: {
        status,
        input: {
          questions: [
            {
              question: "Choose Red or Blue?",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
          ],
        },
      },
    },
  });
}

function sessionIdleEvent() {
  return runtimeEvent("session.idle", { sessionID: "s1" });
}

function abortErrorEvent() {
  return runtimeEvent("session.error", {
    sessionID: "s1",
    error: { name: "MessageAbortedError", data: { message: "aborted" } },
  });
}

async function flushLegacyQuestion(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
}

function permissionEvent(type: "permission.asked" | "permission.updated") {
  return runtimeEvent(type, {
    id: "perm-1",
    type: "bash",
    sessionID: "s1",
    messageID: "m1",
    title: "Run command",
    metadata: { command: "npm test" },
    time: { created: 0 },
  });
}

async function expectReports(
  action: (hooks: ReturnType<typeof testHooks>["hooks"]) => Promise<void>,
  expected: Report[],
): Promise<void> {
  const { hooks, reports } = testHooks();
  await action(hooks);
  expect(reports).toEqual(expected);
}

async function expectEventReports(
  input: ReturnType<typeof runtimeEvent>,
  expected: Report[],
): Promise<void> {
  await expectReports(async (hooks) => {
    await hooks.event?.(input);
  }, expected);
}

async function expectBusyThen(input: ReturnType<typeof runtimeEvent>): Promise<void> {
  await expectReports(
    async (hooks) => {
      await hooks.event?.(sessionStatus("busy"));
      await hooks.event?.(input);
    },
    ["started", "cleared"],
  );
}

describe("Pragma opencode plugin", () => {
  it("reports busy then idle session status", async () => {
    await expectReports(
      async (hooks) => {
        await hooks.event?.(sessionStatus("busy"));
        await hooks.event?.(sessionStatus("idle"));
      },
      ["started", "stopped"],
    );
  });

  it("reports finished after each consecutive agent turn", async () => {
    await expectReports(
      async (hooks) => {
        await hooks.event?.(sessionStatus("busy"));
        await hooks.event?.(sessionStatus("idle"));
        await hooks.event?.(sessionStatus("busy"));
        await hooks.event?.(sessionStatus("idle"));
      },
      ["started", "stopped", "started", "stopped"],
    );
  });

  it("preserves report order when consecutive lifecycle events overlap", async () => {
    const reports: Report[] = [];
    let releaseStarted: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const hooks = createPragmaOpencodeHooks({
      env: pragmaEnv,
      async started() {
        await startedGate;
        reports.push("started");
      },
      async stopped() {
        reports.push("stopped");
      },
      async attention(kind) {
        reports.push(`attention:${kind}`);
      },
      async attentionCommand() {},
      async attentionQuestion() {},
      async attentionQuestions() {},
      async message() {},
      async cleared() {
        reports.push("cleared");
      },
      async sessionName() {},
    });

    const started = hooks.event?.(sessionStatus("busy"));
    const stopped = hooks.event?.(sessionStatus("idle"));
    await Promise.resolve();
    expect(reports).toEqual([]);

    releaseStarted?.();
    await Promise.all([started, stopped]);
    expect(reports).toEqual(["started", "stopped"]);
  });

  it("ignores child-session activity while reporting the parent session", async () => {
    const { hooks, reports } = testHooks();
    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(
      runtimeEvent("session.created", {
        info: { id: "child-1", parentID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("session.status", { sessionID: "child-1", status: { type: "busy" } }),
    );
    await hooks.event?.(runtimeEvent("session.idle", { sessionID: "child-1" }));
    await hooks.event?.(
      runtimeEvent("permission.asked", {
        id: "child-permission",
        sessionID: "child-1",
        type: "bash",
        metadata: { command: "npm test" },
      }),
    );
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "child-1", callID: "child-call" },
      { args: { command: "npm test" } },
    );

    expect(reports).toEqual(["started"]);

    await hooks.event?.(sessionIdleEvent());
    expect(reports).toEqual(["started", "stopped"]);
  });

  it("keeps the parent running until all subagents finish and the parent idles", async () => {
    const { hooks, reports, messages } = testHooks();
    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(
      runtimeEvent("session.created", { info: { id: "child-1", parentID: "s1" } }),
    );
    await hooks.event?.(
      runtimeEvent("session.created", { info: { id: "child-2", parentID: "s1" } }),
    );

    expect(messages.some((message) => message.subAgentsActive === 2)).toBe(true);

    await hooks.event?.(sessionIdleEvent());
    await hooks.event?.(runtimeEvent("session.idle", { sessionID: "child-1" }));
    await hooks.event?.(sessionIdleEvent());
    await hooks.event?.(runtimeEvent("session.idle", { sessionID: "child-2" }));

    expect(reports).toEqual(["started"]);

    await hooks.event?.(sessionIdleEvent());
    expect(reports).toEqual(["started", "stopped"]);
  });

  it("keeps child classification when session.updated omits parentID", async () => {
    const { hooks, reports } = testHooks();
    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(
      runtimeEvent("session.created", { info: { id: "child-1", parentID: "s1" } }),
    );
    await hooks.event?.(runtimeEvent("session.updated", { info: { id: "child-1" } }));
    await hooks.event?.(runtimeEvent("session.idle", { sessionID: "child-1" }));

    expect(reports).toEqual(["started"]);
  });

  it("reports the session title from session events, deduplicating repeats", async () => {
    const { hooks, sessionNames } = testHooks();
    await hooks.event?.(
      runtimeEvent("session.updated", { info: { id: "s1", title: "Fix flaky tests" } }),
    );
    await hooks.event?.(
      runtimeEvent("session.updated", { info: { id: "s1", title: "Fix flaky tests" } }),
    );
    // A rename (or a switch to another session) reports the new name.
    await hooks.event?.(
      runtimeEvent("session.updated", { info: { id: "s2", title: "Port CI to Linux" } }),
    );
    expect(sessionNames).toEqual(["Fix flaky tests", "Port CI to Linux"]);
  });

  it("never renames the tab for child (subagent) session titles", async () => {
    const { hooks, sessionNames } = testHooks();
    await hooks.event?.(
      runtimeEvent("session.created", { info: { id: "child-1", parentID: "s1" } }),
    );
    await hooks.event?.(
      runtimeEvent("session.updated", {
        info: { id: "child-1", parentID: "s1", title: "Subtask" },
      }),
    );
    expect(sessionNames).toEqual([]);
  });

  it("reports started on retry session status", async () => {
    await expectEventReports(sessionStatus("retry"), ["started"]);
  });

  it("reports started on a user chat message", async () => {
    await expectReports(
      async (hooks) => {
        await hooks["chat.message"]?.({ sessionID: "s1" }, { message: {} as never, parts: [] });
      },
      ["started"],
    );
  });

  async function expectStoppedAfter(input: ReturnType<typeof runtimeEvent>) {
    const { hooks, reports } = testHooks();
    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(input);
    expect(reports).toEqual(["started", "stopped"]);
  }

  it("reports stopped after a running turn idles", async () => {
    await expectStoppedAfter(sessionIdleEvent());
  });

  it("reports stopped after a running turn is deleted", async () => {
    await expectStoppedAfter(runtimeEvent("session.deleted", { info: { id: "s1" } }));
  });

  it("reports stopped after a running turn errors (non-abort)", async () => {
    await expectStoppedAfter(runtimeEvent("session.error", { sessionID: "s1" }));
  });

  it("does not report a phantom stopped for a bare idle with no prior activity", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionIdleEvent());

    expect(reports).toEqual([]);
  });

  it("clears (resets) on an aborted turn instead of reporting finished", async () => {
    await expectBusyThen(abortErrorEvent());
  });

  it("does not resurrect a finished dot from the idle that trails an abort", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(abortErrorEvent());
    // opencode may emit a trailing idle after the abort; it must stay cleared.
    await hooks.event?.(sessionIdleEvent());

    expect(reports).toEqual(["started", "cleared"]);
  });

  it("clears on server instance disposal even without the dispose hook", async () => {
    await expectBusyThen(runtimeEvent("server.instance.disposed", { directory: "/tmp/project" }));
  });

  it("coalesces repeated busy events into a single started report", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(sessionStatus("busy"));
    await hooks["chat.message"]?.({ sessionID: "s1" }, { message: {} as never, parts: [] });

    expect(reports).toEqual(["started"]);
  });

  it("ignores passive stream and update events so green is not clobbered", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(sessionStatus("idle"));
    // A trailing flurry of stream/update events must not flip the tab back to yellow.
    await hooks.event?.({
      event: { type: "message.updated", properties: { info: { id: "m1" } } } as never,
    });
    await hooks.event?.({
      event: { type: "message.part.delta", properties: { sessionID: "s1", delta: "hi" } } as never,
    });
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: { id: "p1", type: "text", text: "done" } },
      } as never,
    });
    await hooks.event?.({
      event: { type: "session.updated", properties: { sessionID: "s1" } } as never,
    });

    expect(reports).toEqual(["started", "stopped"]);
  });

  it("reports assistant text from message.part.updated after remembering the role", async () => {
    const { hooks, reports, messages } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "asst-1", role: "assistant", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "asst-1",
          type: "text",
          text: "Hello from opencode",
        },
      }),
    );
    await hooks.event?.(sessionIdleEvent());

    expect(reports).toEqual(["started", "stopped"]);
    expect(messages).toEqual([
      { id: "assistant:asst-1", role: "assistant", text: "Hello from opencode" },
    ]);
  });

  it("reports an assistant text part before its role event arrives", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "asst-1",
          type: "text",
          text: "Streaming before metadata",
        },
      }),
    );

    expect(messages).toEqual([
      { id: "assistant:asst-1", role: "assistant", text: "Streaming before metadata" },
    ]);
  });

  it("upserts streaming assistant text under a stable message id", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "asst-1", role: "assistant", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "asst-1",
          type: "text",
          text: "Hel",
        },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "asst-1",
          type: "text",
          text: "Hello",
        },
      }),
    );

    expect(messages).toEqual([
      { id: "assistant:asst-1", role: "assistant", text: "Hel" },
      { id: "assistant:asst-1", role: "assistant", text: "Hello" },
    ]);
  });

  it("accumulates message.part.delta text for live streaming", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "asst-1", role: "assistant", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.delta", {
        sessionID: "s1",
        messageID: "asst-1",
        partID: "p1",
        field: "text",
        delta: "## Lorem ",
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.delta", {
        sessionID: "s1",
        messageID: "asst-1",
        partID: "p1",
        field: "text",
        delta: "ipsum\n\n**dolor**",
      }),
    );

    expect(messages).toEqual([
      { id: "assistant:asst-1", role: "assistant", text: "## Lorem " },
      {
        id: "assistant:asst-1",
        role: "assistant",
        text: "## Lorem ipsum\n\n**dolor**",
      },
    ]);
  });

  it("reports reasoning parts as muted system messages", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "asst-1", role: "assistant", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "reasoning-1",
          sessionID: "s1",
          messageID: "asst-1",
          type: "reasoning",
          text: "Checking",
        },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.delta", {
        sessionID: "s1",
        messageID: "asst-1",
        partID: "reasoning-1",
        field: "text",
        delta: " dependencies",
      }),
    );

    expect(messages).toEqual([
      {
        id: "reasoning:asst-1:reasoning-1",
        role: "system",
        text: "Checking",
      },
      {
        id: "reasoning:asst-1:reasoning-1",
        role: "system",
        text: "Checking dependencies",
      },
    ]);
  });

  it("does not report user text deltas", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "user-1", role: "user", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.delta", {
        sessionID: "s1",
        messageID: "user-1",
        partID: "p1",
        field: "text",
        delta: "user typed this",
      }),
    );

    expect(messages).toEqual([]);
  });

  it("does not report user text parts from message.part.updated (chat.message owns those)", async () => {
    const { hooks, messages } = testHooks();

    await hooks.event?.(
      runtimeEvent("message.updated", {
        info: { id: "user-1", role: "user", sessionID: "s1" },
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "user-1",
          type: "text",
          text: "user typed this",
        },
      }),
    );

    expect(messages).toEqual([]);
  });

  it("extracts user text from chat.message parts, not the input metadata", async () => {
    const { hooks, messages } = testHooks();

    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      {
        message: { id: "u1", role: "user" } as never,
        parts: [{ id: "p1", type: "text", text: "What files are here?" } as never],
      },
    );

    expect(messages).toEqual([
      { id: expect.stringMatching(/^chat:/), role: "user", text: "What files are here?" },
    ]);
  });

  it("keeps attention pinned over a concurrent idle (red > green)", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(questionPart("pending"));
    await flushLegacyQuestion();
    // opencode reports the session idle while it waits for the answer; red must hold.
    await hooks.event?.(sessionIdleEvent());

    expect(reports).toEqual(["attention:question"]);
  });

  it("reports question attention then resumes when the tool completes", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(questionPart("pending"));
    await flushLegacyQuestion();
    await hooks.event?.(questionPart("completed"));

    expect(reports).toEqual(["attention:question", "started"]);
  });

  it("resumes when a question tool errors", async () => {
    await expectEventReports(questionPart("error"), ["started"]);
  });

  it("reports a command attention (with the command) for the asked event then resumes when replied", async () => {
    const { hooks, reports, commands } = testHooks();

    await hooks.event?.(permissionEvent("permission.asked"));
    await hooks.event?.(
      runtimeEvent("permission.replied", {
        sessionID: "s1",
        permissionID: "perm-1",
        response: "allow",
      }),
    );

    expect(reports).toEqual(["attention:command", "started"]);
    expect(commands).toEqual(["npm test"]);
  });

  it("keeps supporting the older typed permission updated event", async () => {
    await expectEventReports(permissionEvent("permission.updated"), ["attention:command"]);
  });

  async function expectCommandText(
    properties: Record<string, unknown>,
    expected: string,
  ): Promise<void> {
    const { hooks, commands } = testHooks();
    await hooks.event?.(runtimeEvent("permission.asked", properties));
    expect(commands).toEqual([expected]);
  }

  it("shows the file path (with a verb) for a file-edit permission", async () => {
    await expectCommandText(
      { id: "perm-1", type: "edit", metadata: { filePath: "src/app.ts" } },
      "Edit src/app.ts",
    );
  });

  it("shows the file path for a write permission", async () => {
    await expectCommandText(
      { id: "perm-1", type: "write", metadata: { path: "notes.md" } },
      "Write notes.md",
    );
  });

  it("shows the file path for a read permission", async () => {
    await expectCommandText(
      { id: "perm-1", type: "read", metadata: { filePath: "secrets.env" } },
      "Read secrets.env",
    );
  });

  it("unwraps a nested permission payload", async () => {
    await expectCommandText(
      { permission: { type: "bash", metadata: { command: "rm -rf build" } } },
      "rm -rf build",
    );
  });

  it("shows a command nested under tool input", async () => {
    await expectCommandText(
      {
        permission: {
          type: "bash",
          metadata: { tool: "bash", input: { command: "bun test packages/opencode-plugin" } },
        },
      },
      "bun test packages/opencode-plugin",
    );
  });

  it("shows a command from argv-style command arrays", async () => {
    await expectCommandText(
      { id: "perm-1", type: "bash", metadata: { input: { command: ["bun", "test"] } } },
      "bun test",
    );
  });

  it("falls back to the generic label when nothing is extractable", async () => {
    await expectCommandText({ id: "perm-1" }, "Run a command");
  });

  it("forwards pragma env vars to opencode shell commands", async () => {
    const { hooks } = testHooks();
    const output = { env: {} };

    await hooks["shell.env"]?.({ cwd: "/tmp/project" }, output);

    expect(output.env).toEqual({
      PRAGMA_GATEWAY_URL: "http://127.0.0.1:1234",
      PRAGMA_GATEWAY_TOKEN: "token",
      PRAGMA_DAEMON_SOCKET: "/tmp/pragma.sock",
      PRAGMA_TAB_ID: "tab-1",
      PRAGMA_WORKTREE_ID: "worktree-1",
    });
  });

  it("clears (not stopped/done) on dispose so a quit agent leaves no indicator", async () => {
    const { hooks, reports } = testHooks();

    await hooks.dispose?.();

    expect(reports).toEqual(["cleared"]);
  });

  it("clears a running agent on dispose instead of leaving it yellow or green", async () => {
    const { hooks, reports } = testHooks();

    await hooks["chat.message"]?.({ sessionID: "s1" }, { message: {} as never, parts: [] });
    await hooks.dispose?.();

    expect(reports).toEqual(["started", "cleared"]);
  });

  it("reports attention for the question tool via tool.execute.before", async () => {
    const { hooks, reports, questions, messages } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "question", sessionID: "s1", callID: "c1" },
      {
        args: {
          questions: [
            {
              question: "Which database?",
              header: "DB",
              options: [
                { label: "Postgres", description: "Relational" },
                { label: "SQLite", description: "Embedded" },
              ],
            },
          ],
        },
      },
    );
    await flushLegacyQuestion();

    expect(reports).toEqual(["attention:question"]);
    expect(questions).toEqual([
      {
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "Embedded" },
        ],
        requestId: "opencode-question-c1",
      },
    ]);
    expect(messages[0]?.toolCalls?.[0]).toMatchObject({
      name: "question",
      summary: "Which database?",
    });
  });

  it("reports multiple questions without collapsing them", async () => {
    const { hooks, reports, questions } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "question", sessionID: "s1", callID: "c1" },
      {
        args: {
          questions: [
            {
              question: "Choose Red or Blue?",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
            {
              question: "Choose Circle or Square?",
              options: [{ label: "Circle" }, { label: "Square" }],
            },
          ],
        },
      },
    );
    await flushLegacyQuestion();

    expect(reports).toEqual(["attention:question"]);
    expect(questions).toEqual([
      {
        question: "Choose Red or Blue?",
        options: [{ label: "Red" }, { label: "Blue" }],
        requestId: "opencode-question-c1",
      },
      {
        question: "Choose Circle or Square?",
        options: [{ label: "Circle" }, { label: "Square" }],
        requestId: "opencode-question-c1",
      },
    ]);
  });

  it("uses canonical question events from OpenCode 1.18", async () => {
    const { hooks, reports, questions } = testHooks();

    await hooks.event?.(
      runtimeEvent("question.asked", {
        id: "que-1",
        sessionID: "s1",
        questions: [
          {
            question: "Choose Red or Blue?",
            header: "Color",
            options: [
              { label: "Red", description: "Warm" },
              { label: "Blue", description: "Cool" },
            ],
          },
        ],
      }),
    );
    await hooks.event?.(
      runtimeEvent("question.replied", {
        sessionID: "s1",
        requestID: "que-1",
        answers: [["Red"]],
      }),
    );

    expect(reports).toEqual(["attention:question", "started"]);
    expect(questions).toEqual([
      {
        question: "Choose Red or Blue?",
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue", description: "Cool" },
        ],
        requestId: "que-1",
      },
    ]);
  });

  it("lets the canonical question event supersede the legacy tool hook", async () => {
    const { hooks, reports, questions } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "question", sessionID: "s1", callID: "c1" },
      {
        args: {
          questions: [
            {
              question: "Choose Red or Blue?",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
          ],
        },
      },
    );
    await hooks.event?.(
      runtimeEvent("question.asked", {
        id: "que-1",
        sessionID: "s1",
        questions: [
          {
            question: "Choose Red or Blue?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      }),
    );
    await flushLegacyQuestion();

    expect(reports).toEqual(["attention:question"]);
    expect(questions).toEqual([
      {
        question: "Choose Red or Blue?",
        options: [{ label: "Red" }, { label: "Blue" }],
        requestId: "que-1",
      },
    ]);
  });

  it("keeps the canonical request id when a legacy question update arrives later", async () => {
    const { hooks, reports, questions } = testHooks();

    await hooks.event?.(
      runtimeEvent("question.asked", {
        id: "que-1",
        sessionID: "s1",
        questions: [
          {
            question: "Choose Red or Blue?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      }),
    );
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          type: "tool",
          tool: "question",
          callID: "c1",
          state: {
            status: "pending",
            input: {
              questions: [
                {
                  question: "Choose Red or Blue?",
                  options: [{ label: "Red" }, { label: "Blue" }],
                },
              ],
            },
          },
        },
      }),
    );
    await flushLegacyQuestion();

    expect(reports).toEqual(["attention:question"]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.requestId).toBe("que-1");
  });

  it("ignores a stale reply while a newer canonical question is active", async () => {
    const { hooks, reports } = testHooks();
    await hooks.event?.(
      runtimeEvent("question.asked", {
        id: "que-2",
        sessionID: "s1",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
      }),
    );
    await hooks.event?.(
      runtimeEvent("question.replied", {
        sessionID: "s1",
        requestID: "que-1",
        answers: [["Yes"]],
      }),
    );

    expect(reports).toEqual(["attention:question"]);
  });

  it("ignores an uncorrelated reply while a canonical question is active", async () => {
    const { hooks, reports } = testHooks();
    await hooks.event?.(
      runtimeEvent("question.asked", {
        id: "que-2",
        sessionID: "s1",
        questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
      }),
    );
    await hooks.event?.(runtimeEvent("question.replied", { sessionID: "s1" }));

    expect(reports).toEqual(["attention:question"]);
  });

  it("does not emit generic attention for an incomplete question tool part", async () => {
    const { hooks, reports } = testHooks();
    await hooks.event?.(
      runtimeEvent("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "m1",
          type: "tool",
          callID: "c1",
          tool: "question",
          state: { status: "pending" },
        },
      }),
    );
    expect(reports).toEqual([]);
  });

  it("reports started for a non-question tool via tool.execute.before", async () => {
    await expectReports(
      async (hooks) => {
        await hooks["tool.execute.before"]?.(
          { tool: "bash", sessionID: "s1", callID: "c1" },
          { args: { command: "npm test" } },
        );
      },
      ["started"],
    );
  });

  it("summarizes bash tool args as the command, not raw JSON", async () => {
    const { hooks, messages } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { args: { command: "npm test", description: "run tests" } },
    );

    expect(messages[0]?.toolCalls?.[0]).toMatchObject({
      name: "bash",
      summary: "npm test",
    });
  });

  it("reports attention for permission via permission.ask hook", async () => {
    const { hooks, reports } = testHooks();

    await hooks["permission.ask"]?.(
      {
        id: "perm-1",
        type: "bash",
        sessionID: "s1",
        messageID: "m1",
        title: "Run command",
        metadata: {},
        time: { created: 0 },
      },
      { status: "ask" },
    );

    expect(reports).toEqual(["attention:command"]);
  });
});

describe("PragmaOpencodePlugin initialization", () => {
  const input = { directory: "/tmp/project" } as never;

  beforeEach(() => {
    sdkMocks.reportCleared.mockClear();
  });

  it("clears any stale status when opencode opens, so a fresh open shows nothing", async () => {
    await PragmaOpencodePlugin(input, { env: pragmaEnv });

    expect(sdkMocks.reportCleared).toHaveBeenCalledTimes(1);
    expect(sdkMocks.reportCleared).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "opencode" }),
    );
  });

  it("does not report on init outside a Pragma terminal", async () => {
    await PragmaOpencodePlugin(input, {
      env: {
        PRAGMA_DAEMON_SOCKET: undefined,
        PRAGMA_GATEWAY_URL: undefined,
        PRAGMA_GATEWAY_TOKEN: undefined,
        PRAGMA_TAB_ID: undefined,
        PRAGMA_WORKTREE_ID: undefined,
      },
    });

    expect(sdkMocks.reportCleared).not.toHaveBeenCalled();
  });
});
