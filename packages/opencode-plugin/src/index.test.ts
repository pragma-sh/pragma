import { describe, expect, it } from "vitest";

import { createPragmaOpencodeHooks } from "./hooks";

type Report = "started" | "stopped" | `attention:${string}`;

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

  it("reports stopped on session idle, deleted, and error", async () => {
    const { hooks: idleHooks, reports: idleReports } = testHooks();
    await idleHooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "s1" } } as never,
    });
    expect(idleReports).toEqual(["stopped"]);

    const { hooks: deletedHooks, reports: deletedReports } = testHooks();
    await deletedHooks.event?.({
      event: { type: "session.deleted", properties: { sessionID: "s1" } } as never,
    });
    expect(deletedReports).toEqual(["stopped"]);

    const { hooks: errorHooks, reports: errorReports } = testHooks();
    await errorHooks.event?.({
      event: { type: "session.error", properties: { sessionID: "s1" } } as never,
    });
    expect(errorReports).toEqual(["stopped"]);
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

  it("reports permission attention then resumes when replied", async () => {
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
    await hooks.event?.({
      event: {
        type: "permission.replied",
        properties: { sessionID: "s1", permissionID: "perm-1", response: "allow" },
      } as never,
    });

    expect(reports).toEqual(["attention:command", "started"]);
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

  it("reports stopped on dispose", async () => {
    const { hooks, reports } = testHooks();

    await hooks.dispose?.();

    expect(reports).toEqual(["stopped"]);
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
