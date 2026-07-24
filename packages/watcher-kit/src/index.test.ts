import { describe, expect, it, vi } from "vitest";

import { createTuiWatcher, questionAnswerKeys, questionFallbackMessage } from "./index";

/** Decision-handling watcher (opencode's shape). */
const approvalWatcher = createTuiWatcher({ agent: "opencode", handleDecisions: true });
/** Interject-only watcher with a paste-commit delay (Claude Code's shape). */
const interjectWatcher = createTuiWatcher({
  agent: "claude-code",
  handleDecisions: false,
  interjectSubmitDelayMs: 1,
});
/** Question-only watcher for agents whose command approvals use blocking hooks. */
const questionWatcher = createTuiWatcher({
  agent: "codex",
  handleDecisions: false,
  handleQuestionAnswers: true,
});
/** Question watcher for a TUI whose question prompt has no free-text editor (Codex). */
const fallbackQuestionWatcher = createTuiWatcher({
  agent: "codex",
  handleDecisions: false,
  handleQuestionAnswers: true,
  questionFreeTextMode: "interject",
});

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

interface AnswerEvent {
  type: "agentAnswer";
  answer: {
    agent: string;
    worktreeId: string;
    tabId: string;
    requestId: string;
    answer?: string;
    dismissed: boolean;
  };
}

interface AttentionEvent {
  type: "agent";
  worktreeId: string;
  tabId: string;
  agent: string;
  status: "attention" | "running" | "done" | "cleared";
  attentionKind: "question" | "command" | null;
  requestId?: string | null;
  question?: string | null;
  options?: Array<{ label: string; description?: string }> | null;
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

function questionAttention(
  requestId: string,
  options: string[],
  overrides: Partial<AttentionEvent> = {},
): AttentionEvent {
  return {
    type: "agent",
    agent: "opencode",
    worktreeId: "wt-1",
    tabId: "tab-1",
    status: "attention",
    attentionKind: "question",
    requestId,
    question: "Which?",
    options: options.map((label) => ({ label })),
    ...overrides,
  };
}

function commandAttention(requestId = "req-1"): AttentionEvent {
  return {
    type: "agent",
    agent: "opencode",
    worktreeId: "wt-1",
    tabId: "tab-1",
    status: "attention",
    attentionKind: "command",
    requestId,
  };
}

function answer(reply: string | null, overrides: Partial<AnswerEvent["answer"]> = {}): AnswerEvent {
  return {
    type: "agentAnswer",
    answer: {
      agent: "opencode",
      worktreeId: "wt-1",
      tabId: "tab-1",
      requestId: "req-q",
      dismissed: reply === null,
      ...(reply !== null ? { answer: reply } : {}),
      ...overrides,
    },
  };
}

describe("questionAnswerKeys", () => {
  it("maps a listed option to its 1-based digit", () => {
    expect(questionAnswerKeys({ dismissed: false, reply: "4", options: ["3", "4", "5"] })).toBe(
      "2",
    );
  });

  it("opens Other then types free-text when the reply is not listed", () => {
    // Other is after three choices: three Down arrows, Enter, then text + Enter.
    expect(
      questionAnswerKeys({ dismissed: false, reply: "forty-two", options: ["3", "4", "5"] }),
    ).toBe("\x1b[B\x1b[B\x1b[B\rforty-two\r");
  });

  it("rejects dismissed / empty replies with Escape", () => {
    expect(questionAnswerKeys({ dismissed: true, reply: null, options: ["a"] })).toBe("\x1b");
    expect(questionAnswerKeys({ dismissed: false, reply: "  ", options: ["a"] })).toBe("\x1b");
  });
});

describe("createTuiWatcher with handleDecisions", () => {
  it("is bound to the configured agent", () => {
    expect(approvalWatcher.agent).toBe("opencode");
  });

  it("sends the approve keystroke on an approve verdict for its session", async () => {
    const { ctx, sendKeys } = context([commandAttention(), decision(true)]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("\r");
  });

  it("sends the deny keystrokes (right, right, enter) on a deny verdict", async () => {
    const { ctx, sendKeys } = context([commandAttention(), decision(false)]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("\x1b[C\x1b[C\r");
  });

  it("honors configured keystrokes", async () => {
    const { ctx, sendKeys } = context([commandAttention(), decision(true)], {
      approveKeys: "y\r",
      denyKeys: "n\r",
    });
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("y\r");
  });

  it("types an interjection's text and submits it", async () => {
    const { ctx, sendKeys } = context([input("focus on the tests")]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("focus on the tests\r");
  });

  it("honors a configured submit key for interjections", async () => {
    const { ctx, sendKeys } = context([input("hello")], { submitKeys: "" });
    await approvalWatcher.watch(ctx as never);
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
                yield commandAttention();
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
    await approvalWatcher.watch(ctx as never);
    expect(connectCount).toBe(2);
    expect(sendKeys).toHaveBeenCalledWith("\r");
  });

  it("survives a sendKeys failure and keeps answering", async () => {
    const { ctx, sendKeys } = context([
      commandAttention("req-1"),
      decision(true, { requestId: "req-1" }),
      commandAttention("req-2"),
      decision(true, { requestId: "req-2" }),
    ]);
    sendKeys.mockRejectedValueOnce(new Error("write failed"));
    await approvalWatcher.watch(ctx as never);
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
                yield commandAttention("req-1");
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

    await approvalWatcher.watch(ctx as never);

    expect(connectCount).toBe(2);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  it("answers a verdict whose command attention it never saw (mid-stream connect)", async () => {
    // The watcher connected after the command attention was raised (or its
    // attention snapshot was already superseded), so no matching attention is
    // remembered. The verdict must still be applied; dropping it would leave
    // the agent stuck at the approval dialog forever.
    const { ctx, sendKeys } = context([decision(false, { requestId: "missed-attention" })]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("\x1b[C\x1b[C\r");
  });

  it("answers a question with the digit for the matching option", async () => {
    const { ctx, sendKeys } = context([questionAttention("req-q", ["3", "4", "5"]), answer("4")]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("2");
  });

  it("waits for the question prompt to mount before sending answer keys", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, sendKeys } = context([questionAttention("req-q", ["3", "4", "5"]), answer("4")]);
      const watching = approvalWatcher.watch(ctx as never);

      await vi.advanceTimersByTimeAsync(149);
      expect(sendKeys).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await watching;
      expect(sendKeys).toHaveBeenCalledWith("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("types a free-text answer via the Other row", async () => {
    const { ctx, sendKeys } = context([
      questionAttention("req-q", ["3", "4", "5"]),
      answer("forty-two"),
    ]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenNthCalledWith(1, "\x1b[B\x1b[B\x1b[B\r");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "forty-two\r");
  });

  it("rejects a dismissed question with Escape", async () => {
    const { ctx, sendKeys } = context([questionAttention("req-q", ["3", "4", "5"]), answer(null)]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledWith("\x1b");
  });

  it("ignores an answer whose request id has no matching question", async () => {
    const { ctx, sendKeys } = context([
      questionAttention("req-q", ["3", "4", "5"]),
      answer("4", { requestId: "wrong-id" }),
    ]);
    await approvalWatcher.watch(ctx as never);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("dedupes a replayed question answer after reconnect", async () => {
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
                yield questionAttention("req-q", ["A", "B"]);
                yield answer("B", { requestId: "req-q" });
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

    await approvalWatcher.watch(ctx as never);
    expect(connectCount).toBe(2);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("2");
  });
});

describe("createTuiWatcher without handleDecisions", () => {
  it("binds to the configured agent", () => {
    expect(interjectWatcher.agent).toBe("claude-code");
  });

  it("applies interjections with a separate submit key and ignores decisions", async () => {
    const { ctx, sendKeys } = context([decision(true), input("do the thing")]);
    await interjectWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(2);
    expect(sendKeys).toHaveBeenNthCalledWith(1, "do the thing");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "\r");
  });

  it("can answer questions without handling command decisions", async () => {
    const { ctx, sendKeys } = context([
      decision(true),
      questionAttention("req-q", ["A", "B"]),
      answer("B"),
    ]);
    await questionWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("2");
  });
});

describe("questionFreeTextMode: interject", () => {
  it("builds a single-line follow-up prompt from question and answer", () => {
    expect(questionFallbackMessage("Which\n  marker?", "  alpha\nbeta ")).toBe(
      'Answer to question "Which marker?": alpha beta',
    );
  });

  it("selects the fallback row, aborts the response, then interjects the answer", async () => {
    const { ctx, sendKeys } = context([
      questionAttention("req-q", ["A", "B"]),
      answer("forty-two"),
    ]);
    await fallbackQuestionWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenNthCalledWith(1, "\x1b[B\x1b[B\r");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "\x1b");
    expect(sendKeys).toHaveBeenNthCalledWith(3, 'Answer to question "Which?": forty-two\r');
    expect(sendKeys).toHaveBeenCalledTimes(3);
  });

  it("still answers listed options with digits and dismissals with Escape", async () => {
    const { ctx, sendKeys } = context([
      questionAttention("req-1", ["A", "B"]),
      answer("B", { requestId: "req-1" }),
      questionAttention("req-2", ["A", "B"]),
      answer(null, { requestId: "req-2" }),
    ]);
    await fallbackQuestionWatcher.watch(ctx as never);
    expect(sendKeys).toHaveBeenNthCalledWith(1, "2");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "\x1b");
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });
});
