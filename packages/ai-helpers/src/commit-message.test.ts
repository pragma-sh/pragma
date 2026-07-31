import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreatePragmaSessionOptions } from "./session.ts";

const mocks = vi.hoisted(() => ({
  createPragmaSession: vi.fn(async (_options: unknown) => ({
    session: {
      dispose: vi.fn(),
    },
  })),
  runPromptToText: vi.fn(async () => "fix: update commit generation"),
  selectModelCandidates: vi.fn(() => [{ id: "fast-model" }]),
}));

vi.mock("./pick-model.ts", () => ({
  selectModelCandidates: mocks.selectModelCandidates,
}));

vi.mock("./model-insights.ts", () => ({
  loadModelInsights: vi.fn(async () => new Map()),
}));

vi.mock("./session.ts", () => ({
  createPragmaSession: mocks.createPragmaSession,
  runPromptToText: mocks.runPromptToText,
}));

import { generateCommitMessage } from "./commit-message.ts";

describe("generateCommitMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves tools enabled so the prompt can inspect repository convention", async () => {
    await generateCommitMessage({
      stagedDiff: "diff --git a/x b/x",
      cwd: "/repo",
      authStorage: {} as AuthStorage,
      registry: { getAvailable: vi.fn(() => []) } as unknown as ModelRegistry,
    });

    const options = mocks.createPragmaSession.mock.calls[0]?.[0] as
      | CreatePragmaSessionOptions
      | undefined;
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("noTools");
    expect(options).not.toHaveProperty("tools");
  });
});
