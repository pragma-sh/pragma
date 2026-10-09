import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunPromptWithFallbackOptions } from "./session.ts";

const mocks = vi.hoisted(() => ({
  runPromptWithFallback: vi.fn(
    async (_options: unknown, _prompt: string, parse: (raw: string) => unknown) =>
      parse("fix: update commit generation"),
  ),
}));

vi.mock("./session.ts", () => ({
  runPromptWithFallback: mocks.runPromptWithFallback,
}));

import { generateCommitMessage } from "./commit-message.ts";

describe("generateCommitMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a fast model and leaves tools enabled to inspect repository convention", async () => {
    const message = await generateCommitMessage({
      stagedDiff: "diff --git a/x b/x",
      cwd: "/repo",
      authStorage: {} as AuthStorage,
      registry: { getAvailable: vi.fn(() => []) } as unknown as ModelRegistry,
    });

    expect(message).toBe("fix: update commit generation");
    const options = mocks.runPromptWithFallback.mock.calls[0]?.[0] as
      | RunPromptWithFallbackOptions
      | undefined;
    expect(options).toBeDefined();
    expect(options?.modelKind).toBe("fast");
    expect(options).not.toHaveProperty("tools");
  });
});
