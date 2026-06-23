import { describe, expect, it } from "vitest";

import {
  buildCommitMessagePrompt,
  buildCommitPlanPrompt,
  cleanCommitMessage,
  cleanCommitPlanDraft,
  COMMIT_DIFF_CHAR_LIMIT,
  COMMIT_PLAN_DIFF_CHAR_LIMIT,
} from "./prompts.ts";

describe("buildCommitMessagePrompt", () => {
  it("embeds the staged diff and convention lookup order", () => {
    const prompt = buildCommitMessagePrompt("diff --git a/x b/x");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain("Read AGENTS.md for a specific commit convention");
    expect(prompt).toContain("inspect `git log` for an existing pattern");
    expect(prompt).toContain("fall back to Conventional Commits");
    expect(prompt).toContain("Output ONLY the commit message as text");
  });

  it("truncates an oversized diff", () => {
    const huge = "x".repeat(COMMIT_DIFF_CHAR_LIMIT + 100);
    const prompt = buildCommitMessagePrompt(huge);
    expect(prompt).toContain("[... diff truncated ...]");
    expect(prompt.length).toBeLessThan(huge.length + 1_000);
  });
});

describe("cleanCommitMessage", () => {
  it("strips a surrounding code fence", () => {
    expect(cleanCommitMessage("```\nfeat: add thing\n```")).toBe("feat: add thing");
  });

  it("strips a language-tagged fence", () => {
    expect(cleanCommitMessage("```text\nfix: bug\n```")).toBe("fix: bug");
  });

  it("trims plain output", () => {
    expect(cleanCommitMessage("  chore: tidy  ")).toBe("chore: tidy");
  });
});

describe("buildCommitPlanPrompt", () => {
  it("embeds allowed paths and asks for exact coverage", () => {
    const prompt = buildCommitPlanPrompt({
      allowedPaths: ["apps/pragma/src/App.tsx", "packages/ai-helpers/src/prompts.ts"],
      status: " M apps/pragma/src/App.tsx",
      diffStat: "1 file changed",
      worktreeDiff: "diff --git a/apps/pragma/src/App.tsx b/apps/pragma/src/App.tsx",
    });

    expect(prompt).toContain("apps/pragma/src/App.tsx");
    expect(prompt).toContain("Every path in `allowedPaths` must appear exactly once");
    expect(prompt).toContain("Read AGENTS.md for a specific commit convention");
    expect(prompt).toContain('{"commits": [{"message": string, "paths": string[]}]}');
  });

  it("truncates an oversized worktree diff", () => {
    const huge = "x".repeat(COMMIT_PLAN_DIFF_CHAR_LIMIT + 100);
    const prompt = buildCommitPlanPrompt({
      allowedPaths: ["x"],
      status: " M x",
      diffStat: "1 file changed",
      worktreeDiff: huge,
    });
    expect(prompt).toContain("[... diff truncated ...]");
    expect(prompt.length).toBeLessThan(huge.length + 1_500);
  });
});

describe("cleanCommitPlanDraft", () => {
  it("strips a json fence and parses commits", () => {
    expect(
      cleanCommitPlanDraft(
        '```json\n{"commits":[{"message":"feat: add thing","paths":["a.ts"]}]}\n```',
      ),
    ).toEqual({ commits: [{ message: "feat: add thing", paths: ["a.ts"] }] });
  });

  it("rejects an empty plan", () => {
    expect(() => cleanCommitPlanDraft('{"commits":[]}')).toThrow("no commit plan");
  });
});
