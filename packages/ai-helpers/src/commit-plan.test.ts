import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunPromptWithFallbackOptions } from "./session.ts";

const mocks = vi.hoisted(() => ({
  runPromptWithFallback: vi.fn(
    async (_options: unknown, _prompt: string, parse: (raw: string) => unknown) =>
      parse(JSON.stringify({ commits: [{ message: "docs: note it", paths: ["README.md"] }] })),
  ),
}));

vi.mock("./session.ts", () => ({
  runPromptWithFallback: mocks.runPromptWithFallback,
}));

import { generateCommitPlan, NoWorktreeChangesError } from "./commit-plan.ts";

const options = {
  allowedPaths: ["README.md"],
  status: " M README.md",
  diffStat: " README.md | 1 +",
  worktreeDiff: "diff --git a/README.md b/README.md",
  cwd: "/repo",
  authStorage: {} as AuthStorage,
  registry: { getAvailable: vi.fn(() => []) } as unknown as ModelRegistry,
};

describe("generateCommitPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The plan used to walk the whole catalog with its own loop, so one provider
   * whose key is rejected failed every attempt and reported the last model's
   * error. The shared path retires that provider after one failure.
   */
  it("plans through the shared fallback path, on a standard model", async () => {
    const plan = await generateCommitPlan(options);

    expect(plan).toEqual({ commits: [{ message: "docs: note it", paths: ["README.md"] }] });
    const passed = mocks.runPromptWithFallback.mock.calls[0]?.[0] as
      | RunPromptWithFallbackOptions
      | undefined;
    expect(passed?.modelKind).toBe("standard");
    expect(passed?.cwd).toBe("/repo");
    expect(passed).not.toHaveProperty("tools");
  });

  it("refuses a worktree with nothing to commit before choosing a model", () => {
    expect(() => generateCommitPlan({ ...options, allowedPaths: [] })).toThrow(
      NoWorktreeChangesError,
    );
    expect(mocks.runPromptWithFallback).not.toHaveBeenCalled();
  });
});
