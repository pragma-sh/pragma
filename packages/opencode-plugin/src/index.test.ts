import { beforeEach, describe, expect, it, vi } from "vitest";

const reportClearedMock = vi.fn((..._args: unknown[]) => Promise.resolve({}));
const reportStartedMock = vi.fn((..._args: unknown[]) => Promise.resolve({}));
const reportStoppedMock = vi.fn((..._args: unknown[]) => Promise.resolve({}));
const reportAttentionMock = vi.fn((..._args: unknown[]) => Promise.resolve({}));

vi.mock("@pragma/sdk", () => ({
  reportCleared: (...args: unknown[]) => reportClearedMock(...args),
  reportStarted: (...args: unknown[]) => reportStartedMock(...args),
  reportStopped: (...args: unknown[]) => reportStoppedMock(...args),
  reportAttention: (...args: unknown[]) => reportAttentionMock(...args),
}));

import { createPragmaOpencodeHooks } from "./hooks";
import PragmaOpencodePlugin from "./index";

type Report = "started" | "stopped" | "cleared" | `attention:${string}`;

function testHooks() {
  const reports: Report[] = [];
  const hooks = createPragmaOpencodeHooks({
    env: {
      PRAGMA_DAEMON_SOCKET: "/tmp/pragma.sock",
      PRAGMA_TAB_ID: "tab-1",
      PRAGMA_WORKTREE_ID: "worktree-1",
    },
    async started() {
      reports.push("started");
    },
    async stopped() {
      reports.push("stopped");
    },
    async attention(kind) {
      reports.push(`attention:${kind}`);
    },
    async cleared() {
      reports.push("cleared");
    },
  });
  return { hooks, reports };
}

function sessionStatus(type: "busy" | "idle" | "retry") {
  return {
    event: {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status:
          type === "retry" ? { type, attempt: 1, message: "rate limited", next: 0 } : { type },
      },
    } as never,
  };
}

function questionPart(status: string) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "m1",
          type: "tool",
          callID: "c1",
          tool: "question",
          state: { status },
        },
      },
    } as never,
  };
}

describe("Pragma opencode plugin", () => {
  it("reports busy then idle session status", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.(sessionStatus("idle"));

    expect(reports).toEqual(["started", "stopped"]);
  });

  it("reports started on retry session status", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("retry"));

    expect(reports).toEqual(["started"]);
  });

  it("reports started on a user chat message", async () => {
    const { hooks, reports } = testHooks();

    await hooks["chat.message"]?.({ sessionID: "s1" }, { message: {} as never, parts: [] });

    expect(reports).toEqual(["started"]);
  });

  async function expectStoppedAfter(terminal: { type: string; properties: unknown }) {
    const { hooks, reports } = testHooks();
    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.({ event: terminal as never });
    expect(reports).toEqual(["started", "stopped"]);
  }

  it("reports stopped after a running turn idles", async () => {
    await expectStoppedAfter({ type: "session.idle", properties: { sessionID: "s1" } });
  });

  it("reports stopped after a running turn is deleted", async () => {
    await expectStoppedAfter({ type: "session.deleted", properties: { info: { id: "s1" } } });
  });

  it("reports stopped after a running turn errors (non-abort)", async () => {
    await expectStoppedAfter({ type: "session.error", properties: { sessionID: "s1" } });
  });

  it("does not report a phantom stopped for a bare idle with no prior activity", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s1" } } as never,
    });

    expect(reports).toEqual([]);
  });

  it("clears (resets) on an aborted turn instead of reporting finished", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        },
      } as never,
    });

    expect(reports).toEqual(["started", "cleared"]);
  });

  it("does not resurrect a finished dot from the idle that trails an abort", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        },
      } as never,
    });
    // opencode may emit a trailing idle after the abort; it must stay cleared.
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s1" } } as never,
    });

    expect(reports).toEqual(["started", "cleared"]);
  });

  it("clears on server instance disposal even without the dispose hook", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(sessionStatus("busy"));
    await hooks.event?.({
      event: {
        type: "server.instance.disposed",
        properties: { directory: "/tmp/project" },
      } as never,
    });

    expect(reports).toEqual(["started", "cleared"]);
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

  it("keeps attention pinned over a concurrent idle (red > green)", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(questionPart("pending"));
    // opencode reports the session idle while it waits for the answer; red must hold.
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s1" } } as never,
    });

    expect(reports).toEqual(["attention:question"]);
  });

  it("reports question attention then resumes when the tool completes", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(questionPart("pending"));
    await hooks.event?.(questionPart("completed"));

    expect(reports).toEqual(["attention:question", "started"]);
  });

  it("resumes when a question tool errors", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.(questionPart("error"));

    expect(reports).toEqual(["started"]);
  });

  it("reports permission attention for documented asked event then resumes when replied", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-1",
          type: "bash",
          sessionID: "s1",
          messageID: "m1",
          title: "Run command",
          metadata: {},
          time: { created: 0 },
        },
      } as never,
    });
    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", permissionID: "perm-1", response: "allow" },
      } as never,
    });

    expect(reports).toEqual(["attention:command", "started"]);
  });

  it("keeps supporting the older typed permission updated event", async () => {
    const { hooks, reports } = testHooks();

    await hooks.event?.({
      event: {
        type: "permission.updated",
        properties: {
          id: "perm-1",
          type: "bash",
          sessionID: "s1",
          messageID: "m1",
          title: "Run command",
          metadata: {},
          time: { created: 0 },
        },
      } as never,
    });

    expect(reports).toEqual(["attention:command"]);
  });

  it("forwards pragma env vars to opencode shell commands", async () => {
    const { hooks } = testHooks();
    const output = { env: {} };

    await hooks["shell.env"]?.({ cwd: "/tmp/project" }, output);

    expect(output.env).toEqual({
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
    const { hooks, reports } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "question", sessionID: "s1", callID: "c1" },
      { args: {} },
    );

    expect(reports).toEqual(["attention:question"]);
  });

  it("reports started for a non-question tool via tool.execute.before", async () => {
    const { hooks, reports } = testHooks();

    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { args: {} },
    );

    expect(reports).toEqual(["started"]);
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
  const pragmaEnv = {
    PRAGMA_DAEMON_SOCKET: "/tmp/pragma.sock",
    PRAGMA_TAB_ID: "tab-1",
    PRAGMA_WORKTREE_ID: "worktree-1",
  };
  const input = { directory: "/tmp/project" } as never;

  beforeEach(() => {
    reportClearedMock.mockClear();
  });

  it("clears any stale status when opencode opens, so a fresh open shows nothing", async () => {
    await PragmaOpencodePlugin(input, { env: pragmaEnv });

    expect(reportClearedMock).toHaveBeenCalledTimes(1);
    expect(reportClearedMock).toHaveBeenCalledWith(expect.objectContaining({ agent: "opencode" }));
  });

  it("does not report on init outside a Pragma terminal", async () => {
    await PragmaOpencodePlugin(input, {
      env: {
        PRAGMA_DAEMON_SOCKET: undefined,
        PRAGMA_TAB_ID: undefined,
        PRAGMA_WORKTREE_ID: undefined,
      },
    });

    expect(reportClearedMock).not.toHaveBeenCalled();
  });
});
