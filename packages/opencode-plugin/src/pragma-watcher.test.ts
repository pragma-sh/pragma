import { describe, expect, it, vi } from "vitest";

import {
  claudeCodeInterjectWatcher,
  cursorInterjectWatcher,
  opencodeApprovalWatcher,
} from "./pragma-watcher";

interface DecisionEvent {
  type: "agentDecision";
  decision: {
    agent: string;
    worktreeId: string;
    tabId: string;
    requestId: string;
    approved: boolean;
  };
}

interface InputEvent {
  type: "agentInput";
  input: { agent: string; worktreeId: string; tabId: string; text: string; requestId?: string };
}

/**
 * Builds a WatcherContext whose agent connection yields `events` then ends,
 * aborting the signal so the watcher's reconnect loop stops instead of spinning.
 * The real `connect` filters to the watcher's agent + tab, so these events are
 * treated as already scoped.
 */
function context(
  events: unknown[],
  config?: { approveKeys?: string; denyKeys?: string; submitKeys?: string },
) {
  const sendKeys = vi.fn(async () => {});
  const controller = new AbortController();
  const ctx = {
    sdk: {
      agents: {
        connect: async () => ({
          async *[Symbol.asyncIterator]() {
            try {
              for (const event of events) {
                yield event;
              }
            } finally {
              // Stop the reconnect loop: a real session aborts on exit.
              controller.abort();
            }
          },
        }),
      },
    },
    agentId: "opencode",
    config,
    session: { id: "sess-1", tabId: "tab-1", worktreeId: "wt-1" },
    output: (async function* () {})(),
    sendKeys,
    reportMessage: async () => {},
    signal: controller.signal,
  };
  return { ctx, sendKeys };
}

function decision(
  approved: boolean,
  overrides: Partial<DecisionEvent["decision"]> = {},
): DecisionEvent {
  return {
    type: "agentDecision",
    decision: {
      agent: "opencode",
      worktreeId: "wt-1",
      tabId: "tab-1",
      requestId: "req-1",
      approved,
      ...overrides,
    },
  };
}

function input(text: string): InputEvent {
  return {
    type: "agentInput",
    input: { agent: "opencode", worktreeId: "wt-1", tabId: "tab-1", text },
  };
}

describe("opencodeApprovalWatcher", () => {
  it("is bound to the opencode agent", () => {
    expect(opencodeApprovalWatcher.agent).toBe("opencode");
  });

  it("sends the approve keystroke on an approve verdict for its session", async () => {
    const { ctx, sendKeys } = context([decision(true)]);
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("\r");
  });

  it("sends the deny keystrokes (right, right, enter) on a deny verdict", async () => {
    const { ctx, sendKeys } = context([decision(false)]);
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("\x1b[C\x1b[C\r");
  });

  it("honors configured keystrokes", async () => {
    const { ctx, sendKeys } = context([decision(true)], { approveKeys: "y\r", denyKeys: "n\r" });
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("y\r");
  });

  it("types an interjection's text and submits it", async () => {
    const { ctx, sendKeys } = context([input("focus on the tests")]);
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("focus on the tests\r");
  });

  it("honors a configured submit key for interjections", async () => {
    const { ctx, sendKeys } = context([input("hello")], { submitKeys: "" });
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("hello");
  });

  it("re-connects after the event stream drops and still answers later verdicts", async () => {
    const sendKeys = vi.fn(async () => {});
    const controller = new AbortController();
    let connectCount = 0;
    const ctx = {
      sdk: {
        agents: {
          connect: async () => {
            connectCount += 1;
            const count = connectCount;
            return {
              async *[Symbol.asyncIterator]() {
                if (count === 1) {
                  // First stream drops with no verdict (gateway hiccup).
                  return;
                }
                yield decision(true);
                controller.abort();
              },
            };
          },
        },
      },
      agentId: "opencode",
      config: undefined,
      session: { id: "sess-1", tabId: "tab-1", worktreeId: "wt-1" },
      output: (async function* () {})(),
      sendKeys,
      reportMessage: async () => {},
      signal: controller.signal,
    };
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(connectCount).toBe(2);
    expect(sendKeys).toHaveBeenCalledWith("\r");
  });

  it("survives a sendKeys failure and keeps answering", async () => {
    const { ctx, sendKeys } = context([
      decision(true, { requestId: "req-1" }),
      decision(true, { requestId: "req-2" }),
    ]);
    sendKeys.mockRejectedValueOnce(new Error("write failed"));
    await opencodeApprovalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  it("ignores a replayed decision it already answered after reconnect", async () => {
    const sendKeys = vi.fn(async () => {});
    const controller = new AbortController();
    let connectCount = 0;
    const ctx = {
      sdk: {
        agents: {
          connect: async () => {
            connectCount += 1;
            const count = connectCount;
            return {
              async *[Symbol.asyncIterator]() {
                yield decision(true, { requestId: "req-1" });
                if (count > 1) {
                  controller.abort();
                }
              },
            };
          },
        },
      },
      agentId: "opencode",
      config: undefined,
      session: { id: "sess-1", tabId: "tab-1", worktreeId: "wt-1" },
      output: (async function* () {})(),
      sendKeys,
      reportMessage: async () => {},
      signal: controller.signal,
    };

    await opencodeApprovalWatcher.watch(ctx as never);

    expect(connectCount).toBe(2);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });
});

describe("interject-only watchers", () => {
  it("bind to their agents", () => {
    expect(claudeCodeInterjectWatcher.agent).toBe("claude-code");
    expect(cursorInterjectWatcher.agent).toBe("cursor");
  });

  it("apply interjections but never answer command verdicts", async () => {
    const { ctx, sendKeys } = context([decision(true), input("do the thing")]);
    await claudeCodeInterjectWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("do the thing\r");
  });
});
