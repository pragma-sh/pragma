import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  resourceLoader: { reload: vi.fn(async () => {}) },
  defaultResourceLoader: vi.fn(),
  settingsManager: {},
  candidates: [] as unknown[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: class {
    reload = mocks.resourceLoader.reload;

    constructor(options: unknown) {
      mocks.defaultResourceLoader(options);
    }
  },
  getAgentDir: () => "/agent-dir",
  SessionManager: { inMemory: () => ({}) },
  SettingsManager: { create: () => mocks.settingsManager },
}));

vi.mock("./model-insights.ts", () => ({
  loadModelInsights: vi.fn(async () => new Map()),
}));

vi.mock("./pick-model.ts", () => ({
  selectModelCandidates: vi.fn(() => mocks.candidates),
  pickModel: vi.fn(() => undefined),
}));

import { RUN_FALLBACK } from "./constants.ts";
import { NoWorkingModelError } from "./run-failure.ts";
import { createPragmaSession, runPromptToText, runPromptWithFallback } from "./session.ts";

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
    dispose: vi.fn(),
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

describe("createPragmaSession", () => {
  it("does not load installed Pi extensions for internal AI work", async () => {
    const session = sessionWithEvents([]);
    mocks.createAgentSession.mockResolvedValue({ session });
    const model = candidate("anthropic", "claude-sonnet", { reply: "ok" });

    await createPragmaSession({ ...fallbackOptions, model });

    expect(mocks.defaultResourceLoader).toHaveBeenCalledWith({
      cwd: "/repo",
      agentDir: "/agent-dir",
      settingsManager: mocks.settingsManager,
      noExtensions: true,
    });
    expect(mocks.resourceLoader.reload).toHaveBeenCalled();
    expect(mocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoader: expect.objectContaining({ reload: mocks.resourceLoader.reload }),
        settingsManager: mocks.settingsManager,
      }),
    );
  });
});

/** A model whose prompt either answers `reply` or throws `fails`. */
function candidate(provider: string, id: string, outcome: { reply?: string; fails?: string }) {
  return { provider, id, outcome } as unknown as Model<Api>;
}

const fallbackOptions = {
  modelKind: "standard" as const,
  cwd: "/repo",
  authStorage: {} as AuthStorage,
  registry: { getAvailable: vi.fn(() => []) } as unknown as ModelRegistry,
};

describe("runPromptWithFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidates = [];
    mocks.createAgentSession.mockImplementation(
      async ({
        model,
      }: {
        model: Model<Api> & { outcome: { reply?: string; fails?: string } };
      }) => {
        const { reply, fails } = model.outcome;
        return {
          session: sessionWithEvents(
            fails
              ? [
                  {
                    type: "message_update",
                    assistantMessageEvent: { type: "error", error: { errorMessage: fails } },
                  },
                ]
              : [
                  {
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta", delta: reply },
                  },
                  { type: "agent_end", messages: [] },
                ],
          ),
        };
      },
    );
  });

  function attemptedIds(): string[] {
    return mocks.createAgentSession.mock.calls.map(
      ([options]) => (options as { model: Model<Api> }).model.id,
    );
  }

  it("skips a provider's remaining models once its credentials are rejected", async () => {
    mocks.candidates = [
      candidate("opencode-go", "minimax-m3", { fails: "401 Invalid API key." }),
      candidate("opencode-go", "glm-5.2", { fails: "401 Invalid API key." }),
      candidate("github-copilot", "gpt-5.4", { reply: "ok" }),
    ];

    await expect(runPromptWithFallback(fallbackOptions, "prompt", (raw) => raw)).resolves.toBe(
      "ok",
    );
    expect(attemptedIds()).toEqual(["minimax-m3", "gpt-5.4"]);
  });

  it("tries a sibling model when only the model itself is refused", async () => {
    mocks.candidates = [
      candidate("opencode-go", "minimax-m3", { fails: "400 model not available" }),
      candidate("opencode-go", "glm-5.2", { reply: "ok" }),
    ];

    await expect(runPromptWithFallback(fallbackOptions, "prompt", (raw) => raw)).resolves.toBe(
      "ok",
    );
    expect(attemptedIds()).toEqual(["minimax-m3", "glm-5.2"]);
  });

  it("gives up after the attempt cap instead of walking the whole catalog", async () => {
    mocks.candidates = Array.from({ length: 12 }, (_, index) =>
      candidate("opencode-go", `model-${index}`, { fails: "400 model not available" }),
    );

    await expect(runPromptWithFallback(fallbackOptions, "prompt", (raw) => raw)).rejects.toThrow(
      NoWorkingModelError,
    );
    expect(attemptedIds()).toHaveLength(RUN_FALLBACK.maxAttempts);
  });

  it("reports every provider's own error, not just the last candidate's", async () => {
    mocks.candidates = [
      candidate("opencode-go", "minimax-m3", { fails: "401 Invalid API key." }),
      candidate("github-copilot", "gpt-5.4", { fails: "429 quota exceeded" }),
      candidate("opencode-go", "glm-5.2", { fails: "401 Invalid API key." }),
    ];

    await expect(runPromptWithFallback(fallbackOptions, "prompt", (raw) => raw)).rejects.toThrow(
      "opencode-go (minimax-m3): 401 Invalid API key. github-copilot (gpt-5.4): 429 quota exceeded",
    );
  });

  it("reports an empty tier without attempting anything", async () => {
    await expect(runPromptWithFallback(fallbackOptions, "prompt", (raw) => raw)).rejects.toThrow(
      "No standard model is available",
    );
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });
});
