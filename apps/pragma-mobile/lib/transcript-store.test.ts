import type { AgentMessage } from "@pragma/constants";
import type { AgentStreamEvent } from "@pragma/sdk";
import { describe, expect, it } from "vitest";

import {
  applyEvent,
  applyLocalInput,
  emptyTranscript,
  transcriptRows,
  type TranscriptState,
} from "./transcript-store";

function msg(overrides: Partial<AgentMessage> & Pick<AgentMessage, "id" | "ts">): AgentMessage {
  return {
    agent: "claude",
    worktreeId: "wt-1",
    tabId: "tab-1",
    role: "assistant",
    subAgentsActive: 0,
    ...overrides,
  };
}

function messageEvent(message: AgentMessage): AgentStreamEvent {
  return { type: "agentMessage", message };
}

function fold(events: AgentStreamEvent[]): TranscriptState {
  return events.reduce(applyEvent, emptyTranscript());
}

describe("transcript-store upsert", () => {
  it("replaces a message with the same id instead of duplicating", () => {
    const state = fold([
      messageEvent(
        msg({ id: "m1", ts: 1, toolCalls: [{ id: "t1", name: "bash", status: "running" }] }),
      ),
      messageEvent(
        msg({ id: "m1", ts: 1, toolCalls: [{ id: "t1", name: "bash", status: "done" }] }),
      ),
    ]);
    expect(state.messages.size).toBe(1);
    const rows = transcriptRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "event",
      text: "bash · done",
      tool: { name: "bash", status: "done" },
    });
  });

  it("keeps a streamed message in its original transcript position", () => {
    const state = fold([
      messageEvent(msg({ id: "stream", ts: 10, text: "Hel" })),
      messageEvent(msg({ id: "later", ts: 20, text: "tool result", role: "tool" })),
      messageEvent(msg({ id: "stream", ts: 30, text: "Hello" })),
    ]);

    expect(transcriptRows(state).map((row) => [row.text, row.ts])).toEqual([
      ["Hello", 10_000],
      ["tool result", 20_000],
    ]);
  });

  it("keeps distinct ids as separate entries", () => {
    const state = fold([
      messageEvent(msg({ id: "m1", ts: 1, text: "first" })),
      messageEvent(msg({ id: "m2", ts: 2, text: "second" })),
    ]);
    expect(state.messages.size).toBe(2);
  });
});

describe("transcript-store ordering", () => {
  it("orders rows by ts ascending regardless of arrival order", () => {
    const state = fold([
      messageEvent(msg({ id: "b", ts: 20, text: "later" })),
      messageEvent(msg({ id: "a", ts: 10, text: "earlier" })),
    ]);
    const rows = transcriptRows(state);
    expect(rows.map((r) => (r.kind === "message" ? r.text : ""))).toEqual(["earlier", "later"]);
  });

  it("breaks ts ties by id for stable ordering", () => {
    const state = fold([
      messageEvent(msg({ id: "z", ts: 5, text: "z" })),
      messageEvent(msg({ id: "a", ts: 5, text: "a" })),
    ]);
    const rows = transcriptRows(state);
    expect(rows.map((r) => (r.kind === "message" ? r.text : ""))).toEqual(["a", "z"]);
  });
});

describe("transcript-store row expansion", () => {
  it("emits a message row, tool rows, file rows, and a sub-agent row", () => {
    const state = fold([
      messageEvent(
        msg({
          id: "m1",
          ts: 1,
          text: "working on it",
          toolCalls: [{ id: "t1", name: "grep", status: "done", summary: "3 hits" }],
          files: [{ path: "src/foo.ts", change: "edited" }],
          subAgentsActive: 2,
        }),
      ),
    ]);
    const rows = transcriptRows(state);
    expect(rows.map((r) => r.text)).toEqual([
      "working on it",
      "grep · done — 3 hits",
      "edited src/foo.ts",
      "spawned 2 sub-agents",
    ]);
  });

  it("omits the prose row when text is blank", () => {
    const state = fold([messageEvent(msg({ id: "m1", ts: 1, text: "   " }))]);
    expect(transcriptRows(state)).toHaveLength(0);
  });

  it("singularizes a single spawned sub-agent", () => {
    const state = fold([messageEvent(msg({ id: "m1", ts: 1, subAgentsActive: 1 }))]);
    expect(transcriptRows(state)[0]?.text).toBe("spawned 1 sub-agent");
  });
});

function attentionEvent(
  over: Partial<Extract<AgentStreamEvent, { type: "agent" }>> = {},
): AgentStreamEvent {
  return {
    type: "agent",
    worktreeId: "wt-1",
    tabId: "tab-1",
    agent: "claude",
    status: "attention",
    attentionKind: "command",
    command: "rm -rf build",
    requestId: "req-1",
    ...over,
  };
}

describe("transcript-store attention", () => {
  it("raises a command attention request", () => {
    const state = applyEvent(emptyTranscript(), attentionEvent());
    expect(state.attention).toEqual({
      kind: "command",
      requestId: "req-1",
      prompt: "rm -rf build",
    });
  });

  it("uses the question text for a question request", () => {
    const state = applyEvent(
      emptyTranscript(),
      attentionEvent({ attentionKind: "question", command: null, question: "Which db?" }),
    );
    expect(state.attention).toMatchObject({ kind: "question", prompt: "Which db?" });
  });

  it("carries answer options on a question request", () => {
    const state = applyEvent(
      emptyTranscript(),
      attentionEvent({
        attentionKind: "question",
        command: null,
        question: "Which db?",
        options: [{ label: "Postgres", description: "Client-server" }, { label: "SQLite" }],
      }),
    );
    expect(state.attention).toMatchObject({
      kind: "question",
      prompt: "Which db?",
      options: [{ label: "Postgres", description: "Client-server" }, { label: "SQLite" }],
    });
  });

  it("normalizes legacy string answer options from an older host", () => {
    const state = applyEvent(
      emptyTranscript(),
      attentionEvent({
        attentionKind: "question",
        command: null,
        question: "Which db?",
        options: ["Postgres", "SQLite"] as never,
      }),
    );
    expect(state.attention?.options).toEqual([{ label: "Postgres" }, { label: "SQLite" }]);
  });

  it("clears attention on a matching decision echo", () => {
    let state = applyEvent(emptyTranscript(), attentionEvent());
    state = applyEvent(state, {
      type: "agentDecision",
      decision: {
        agent: "claude",
        worktreeId: "wt-1",
        tabId: "tab-1",
        requestId: "req-1",
        approved: true,
      },
    });
    expect(state.attention).toBeNull();
  });

  it("ignores a decision echo for a different request", () => {
    let state = applyEvent(emptyTranscript(), attentionEvent());
    state = applyEvent(state, {
      type: "agentDecision",
      decision: {
        agent: "claude",
        worktreeId: "wt-1",
        tabId: "tab-1",
        requestId: "other",
        approved: true,
      },
    });
    expect(state.attention?.requestId).toBe("req-1");
  });

  it("clears attention when the agent moves on to a non-attention status", () => {
    let state = applyEvent(emptyTranscript(), attentionEvent());
    state = applyEvent(
      state,
      attentionEvent({ status: "running", attentionKind: null, requestId: null }),
    );
    expect(state.attention).toBeNull();
  });
});

describe("transcript-store local input", () => {
  it("appends an optimistic user message", () => {
    const ts = 1_700_000_000_042;
    const state = applyLocalInput(emptyTranscript(), "hello", ts);
    const rows = transcriptRows(state);
    expect(rows).toEqual([
      { kind: "message", id: `local-input-${ts}`, role: "user", text: "hello", ts },
    ]);
  });

  it("replaces a matching optimistic message with the agent-reported user message", () => {
    const ts = 1_700_000_000_042;
    let state = applyLocalInput(emptyTranscript(), "hello", ts);
    state = applyEvent(
      state,
      messageEvent(msg({ id: "user-1", role: "user", text: "hello", ts: ts + 500 })),
    );

    expect(transcriptRows(state)).toEqual([
      { kind: "message", id: "user-1", role: "user", text: "hello", ts: ts + 500 },
    ]);
  });

  it("reconciles only one optimistic message for repeated identical sends", () => {
    const ts = 1_700_000_000_042;
    let state = applyLocalInput(emptyTranscript(), "hello", ts);
    state = applyLocalInput(state, "hello", ts + 1);
    state = applyEvent(
      state,
      messageEvent(msg({ id: "user-1", role: "user", text: "hello", ts: ts + 500 })),
    );

    expect(transcriptRows(state)).toHaveLength(2);
  });
});

describe("transcript-store timestamp normalization", () => {
  it("promotes second-era agent timestamps so they sort with Date.now() local input", () => {
    const localTs = 1_700_000_000_500;
    const agentSeconds = 1_700_000_001;
    let state = applyLocalInput(emptyTranscript(), "hello", localTs);
    state = applyEvent(
      state,
      messageEvent(msg({ id: "a1", ts: agentSeconds, text: "pong", role: "assistant" })),
    );
    const rows = transcriptRows(state);
    expect(rows.map((r) => (r.kind === "message" ? r.text : ""))).toEqual(["hello", "pong"]);
    expect(rows[1]?.ts).toBe(agentSeconds * 1000);
  });

  it("leaves already-millisecond timestamps alone", () => {
    const ts = 1_700_000_000_500;
    const state = fold([messageEvent(msg({ id: "a1", ts, text: "hi" }))]);
    expect(transcriptRows(state)[0]?.ts).toBe(ts);
  });
});
