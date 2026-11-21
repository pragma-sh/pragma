import { describe, expect, test } from "vitest";

import {
  emptyState,
  handleHook,
  questionEntries,
  sessionNameFrom,
  type HookState,
  type TurnReading,
} from "../src/hook/handle";

const PARENT = "parent-conv";
const CHILD = "child-conv";

/** Runs a sequence of hook events and collects the report argv tails. */
function run(
  events: Array<[string, Record<string, unknown>]>,
  turn: TurnReading | null = { userStep: 4, prompt: "Fix the bug", assistantText: "" },
  initial: HookState = emptyState(),
) {
  let state = initial;
  const commands: string[][] = [];
  for (const [event, payload] of events) {
    const out = handleHook({
      event,
      payload: { transcriptPath: "/t.jsonl", ...payload },
      state,
      tab: "tab1",
      readTurn: () => turn,
      now: 1_000,
    });
    state = out.state;
    commands.push(...out.commands);
  }
  return { state, commands };
}

const statuses = (commands: string[][]) =>
  commands.filter((c) => c[0] === "report").map((c) => c.slice(3).join(" "));
const messages = (commands: string[][]) =>
  commands
    .filter((c) => c[0] === "message")
    .map((c) => JSON.parse(c[4] ?? "{}") as Record<string, unknown>);

const parent = (extra: Record<string, unknown> = {}) => ({
  conversationId: PARENT,
  lastUserInput: "Fix the bug",
  ...extra,
});
const child = (extra: Record<string, unknown> = {}) => ({
  conversationId: CHILD,
  lastUserInput: "",
  ...extra,
});

describe("turn lifecycle", () => {
  test("a normal turn reports started then stopped, with session id and name", () => {
    const { commands, state } = run([
      ["SessionStart", parent()],
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["Stop", parent({ terminationReason: "NO_TOOL_CALL", fullyIdle: true })],
    ]);
    expect(statuses(commands)).toEqual([
      `session-id --id ${PARENT}`,
      "cleared",
      "started",
      "session-name --name Fix the bug",
      "stopped",
    ]);
    expect(state.turnActive).toBe(false);
    expect(messages(commands)[0]).toMatchObject({ role: "user", text: "Fix the bug" });
  });

  test("a stop with no tracked turn creates no phantom done", () => {
    const { commands } = run([["Stop", parent({ terminationReason: "NO_TOOL_CALL" })]]);
    expect(statuses(commands)).not.toContain("stopped");
  });

  test.each(["USER_CANCELED", "ERROR"])("%s clears instead of reporting done", (reason) => {
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["Stop", parent({ terminationReason: reason, error: "boom" })],
    ]);
    expect(statuses(commands).at(-1)).toBe("cleared");
    expect(statuses(commands)).not.toContain("stopped");
  });

  test("later invocations are running heartbeats, not new turns", () => {
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["PreInvocation", parent({ invocationNum: 1 })],
    ]);
    expect(statuses(commands).filter((s) => s === "started")).toHaveLength(2);
    expect(messages(commands).filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("the session id and name are reported once per conversation", () => {
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["Stop", parent({ terminationReason: "NO_TOOL_CALL" })],
      ["PreInvocation", parent({ invocationNum: 0, lastUserInput: "Next" })],
    ]);
    const reports = statuses(commands);
    expect(reports.filter((s) => s.startsWith("session-id"))).toHaveLength(1);
    expect(reports.filter((s) => s.startsWith("session-name"))).toHaveLength(1);
  });
});

describe("assistant messages", () => {
  test("stream under one stable id and only when the text grows", () => {
    const turn = { userStep: 4, prompt: "Hi", assistantText: "Hello" };
    const { commands } = run(
      [
        ["PreInvocation", parent({ invocationNum: 0 })],
        ["PostInvocation", parent()],
        ["PostInvocation", parent()],
        ["Stop", parent({ terminationReason: "NO_TOOL_CALL" })],
      ],
      turn,
    );
    const replies = messages(commands).filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: `antigravity-${PARENT}-4-assistant`, text: "Hello" });
    // The reply precedes the done report.
    const order = commands.map((c) => (c[0] === "message" ? "message" : c[3]));
    expect(order.lastIndexOf("message")).toBeLessThan(order.lastIndexOf("stopped"));
  });
});

describe("sub-agents", () => {
  test("are counted and keep the turn running until the last one stops", () => {
    const { commands, state } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["SessionStart", child()],
      ["PreInvocation", child({ invocationNum: 0 })],
      ["Stop", parent({ terminationReason: "NO_TOOL_CALL", fullyIdle: false })],
    ]);
    expect(statuses(commands)).not.toContain("stopped");
    expect(state.idlePending).toBe(true);
    expect(messages(commands).some((m) => m.subAgentsActive === 1)).toBe(true);

    const done = run([["Stop", child({ terminationReason: "NO_TOOL_CALL" })]], null, state);
    expect(statuses(done.commands)).toEqual(["stopped"]);
  });

  test("a sub-agent's own stop or invocation never ends or restarts the parent turn", () => {
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["SessionStart", child()],
      ["Stop", child({ terminationReason: "NO_TOOL_CALL" })],
    ]);
    expect(statuses(commands)).toEqual([
      `session-id --id ${PARENT}`,
      "started",
      "session-name --name Fix the bug",
    ]);
  });
});

describe("tools", () => {
  test("ask_question raises a question attention and its answer resumes running", () => {
    const call = {
      id: "call_1",
      name: "ask_question",
      args: {
        questions: [
          {
            question: "Choose Red or Blue?",
            options: ["(Recommended) Red", "Blue"],
            is_multi_select: false,
          },
        ],
      },
    };
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["PreToolUse", parent({ toolCall: call })],
      ["PostToolUse", parent({ toolCall: call })],
    ]);
    const attention = commands.find((c) => c[3] === "attention");
    expect(attention).toEqual([
      "report",
      "--agent",
      "antigravity",
      "attention",
      "--kind",
      "question",
      "--question",
      "Choose Red or Blue?",
      "--options",
      JSON.stringify([{ label: "Red" }, { label: "Blue" }]),
      "--request-id",
      "antigravity-tab1-call_1",
    ]);
    expect(statuses(commands).at(-1)).toBe("started");
  });

  test("several questions become one multi-question attention that still names the first", () => {
    const questions = [
      { question: "A?", options: ["1", "2"] },
      { question: "B?", options: ["3"] },
    ];
    expect(questionEntries(questions)).toHaveLength(2);
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      ["PreToolUse", parent({ toolCall: { id: "q", name: "ask_question", args: { questions } } })],
    ]);
    const attention = commands.find((c) => c[3] === "attention") ?? [];
    expect(attention[attention.indexOf("--question") + 1]).toBe("A?");
    expect(JSON.parse(attention[attention.indexOf("--questions") + 1] ?? "[]")).toHaveLength(2);
  });

  test("multi-select questions stay on the native prompt", () => {
    expect(questionEntries([{ question: "A?", options: ["x"], is_multi_select: true }])).toBeNull();
  });

  test("a tool call reports running with its command", () => {
    const { commands } = run([
      ["PreInvocation", parent({ invocationNum: 0 })],
      [
        "PreToolUse",
        parent({ toolCall: { id: "c", name: "run_command", args: { CommandLine: "ls" } } }),
      ],
    ]);
    expect(messages(commands).at(-1)).toMatchObject({ role: "tool", text: "ls" });
  });
});

test("session names use the first line, truncated", () => {
  expect(sessionNameFrom("\n  first line\nsecond")).toBe("first line");
  expect(sessionNameFrom("x".repeat(60))).toHaveLength(48);
});
