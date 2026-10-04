import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunPromptWithFallbackOptions } from "./session.ts";

const mocks = vi.hoisted(() => ({
  runPromptWithFallback: vi.fn(
    async (_options: unknown, _prompt: string, parse: (raw: string) => unknown) =>
      parse(JSON.stringify({ title: "Add PR generation", body: "## Summary\n\nAdds generation." })),
  ),
}));

vi.mock("./session.ts", () => ({
  runPromptWithFallback: mocks.runPromptWithFallback,
}));

import { generatePullRequestDraft } from "./pull-request.ts";

describe("generatePullRequestDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a standard model and leaves tools enabled for code investigation", async () => {
    const draft = await generatePullRequestDraft({
      gitLog: "abc123 add PR generation",
      diffStat: "file.ts | 2 ++",
      committedDiff: "diff --git a/file.ts b/file.ts",
      cwd: "/repo",
      authStorage: {} as AuthStorage,
      registry: { getAvailable: vi.fn(() => []) } as unknown as ModelRegistry,
    });

    expect(draft).toEqual({ title: "Add PR generation", body: "## Summary\n\nAdds generation." });
    const options = mocks.runPromptWithFallback.mock.calls[0]?.[0] as
      | RunPromptWithFallbackOptions
      | undefined;
    expect(options).toBeDefined();
    expect(options?.modelKind).toBe("standard");
    // Tools stay at pi's defaults: the draft is better when the model can read
    // the code the commits touched.
    expect(options).not.toHaveProperty("tools");
    const prompt = (mocks.runPromptWithFallback.mock.calls[0] as unknown[] | undefined)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain("Do not ask the user questions");
    expect(prompt).toContain("if you want me to");
  });
});
