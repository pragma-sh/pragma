import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { runPromptToText } from "./session.ts";

function sessionWithEvents(events: readonly unknown[]): AgentSession {
  let listener: ((event: unknown) => void) | undefined;
  return {
    subscribe: vi.fn((next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    }),
    prompt: vi.fn(async () => {
      for (const event of events) listener?.(event);
    }),
  } as unknown as AgentSession;
}

describe("runPromptToText", () => {
  it("resolves streamed assistant text deltas", async () => {
    const session = sessionWithEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "feat: " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ship it" } },
      { type: "agent_end", messages: [] },
    ]);

    await expect(runPromptToText(session, "prompt")).resolves.toBe("feat: ship it");
  });

  it("falls back to the final assistant message when no text deltas arrive", async () => {
    const session = sessionWithEvents([
      {
        type: "agent_end",
        messages: [
          { role: "user", content: "prompt" },
          {
            role: "assistant",
            content: [{ type: "text", text: "fix: populate commit message" }],
          },
        ],
      },
    ]);

    await expect(runPromptToText(session, "prompt")).resolves.toBe("fix: populate commit message");
  });

  it("uses the message_end assistant snapshot when no text deltas arrive", async () => {
    const session = sessionWithEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fix: fill generated commit message" }],
        },
      },
      { type: "agent_end", messages: [] },
    ]);

    await expect(runPromptToText(session, "prompt")).resolves.toBe(
      "fix: fill generated commit message",
    );
  });

  it("uses text_end content when a provider does not stream deltas", async () => {
    const session = sessionWithEvents([
      {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_end", content: "feat: handle chatgpt pro output" },
      },
      { type: "agent_end", messages: [] },
    ]);

    await expect(runPromptToText(session, "prompt")).resolves.toBe(
      "feat: handle chatgpt pro output",
    );
  });

  it("waits for the final agent_end when the session retries", async () => {
    const session = sessionWithEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stale" } },
      {
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", content: [{ type: "text", text: "stale" }] }],
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "fix: retry" },
      },
      { type: "agent_end", willRetry: false, messages: [] },
    ]);

    await expect(runPromptToText(session, "prompt")).resolves.toBe("fix: retry");
  });

  it("rejects when the model run finishes without text", async () => {
    const session = sessionWithEvents([{ type: "agent_end", messages: [] }]);

    await expect(runPromptToText(session, "prompt")).rejects.toThrow("The model returned no text.");
  });

  it("rejects with the provider error when the final assistant message failed", async () => {
    const session = sessionWithEvents([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "429 Monthly usage limit reached.",
          content: [],
        },
      },
      { type: "agent_end", messages: [] },
    ]);

    await expect(runPromptToText(session, "prompt")).rejects.toThrow(
      "429 Monthly usage limit reached.",
    );
  });
});
