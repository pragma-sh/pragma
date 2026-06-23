import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreatePragmaSessionOptions } from "./session.ts";

const mocks = vi.hoisted(() => ({
  createPragmaSession: vi.fn(async (_options: unknown) => ({
    session: {
      dispose: vi.fn(),
    },
  })),
  runPromptToText: vi.fn(async () =>
    JSON.stringify({ title: "Add PR generation", body: "## Summary\n\nAdds generation." }),
  ),
  selectModelCandidates: vi.fn(() => [{ id: "standard-model" }]),
}));

vi.mock("./pick-model.ts", () => ({
  selectModelCandidates: mocks.selectModelCandidates,
}));

vi.mock("./session.ts", () => ({
  createPragmaSession: mocks.createPragmaSession,
  runPromptToText: mocks.runPromptToText,
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
    const options = mocks.createPragmaSession.mock.calls[0]?.[0] as
      | CreatePragmaSessionOptions
      | undefined;
    expect(options).toBeDefined();
    expect(options?.modelKind).toBe("standard");
    expect(options).not.toHaveProperty("noTools");
    expect(options).not.toHaveProperty("tools");
    const prompt = (mocks.runPromptToText.mock.calls[0] as unknown[] | undefined)?.[1] as
      | string
      | undefined;
    expect(prompt).toContain("Do not ask the user questions");
    expect(prompt).toContain("if you want me to");
  });
});
