import { describe, expect, it } from "vitest";

import {
  buildAskAiPrompt,
  buildCommitMessagePrompt,
  buildCommitPlanPrompt,
  buildInlineEditPrompt,
  cleanCommitMessage,
  cleanCommitPlanDraft,
  cleanInlineEditDraft,
  COMMIT_DIFF_CHAR_LIMIT,
  COMMIT_PLAN_DIFF_CHAR_LIMIT,
  INLINE_EDIT_FILE_CHAR_LIMIT,
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

describe("buildInlineEditPrompt", () => {
  const doc = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

  it("embeds the instruction, selection and line-numbered buffer", () => {
    const prompt = buildInlineEditPrompt({
      filePath: "src/x.ts",
      instruction: "rename b to total",
      doc,
      startLine: 2,
      endLine: 2,
    });
    expect(prompt).toContain("File: `src/x.ts`");
    expect(prompt).toContain("Selected lines: 2-2");
    expect(prompt).toContain("> rename b to total");
    expect(prompt).toContain("2\tconst b = 2;");
    expect(prompt).toContain("Buffer (line-numbered):");
    expect(prompt).toContain(
      '{"summary": string, "edits": [{"oldText": string, "newText": string}]}',
    );
  });

  it("tells the model it may edit outside the selection but not other files", () => {
    const prompt = buildInlineEditPrompt({
      filePath: "src/x.ts",
      instruction: "add an import",
      doc,
      startLine: 1,
      endLine: 1,
    });
    expect(prompt).toContain("not only the selected lines");
    expect(prompt).toContain("Change only this file");
    expect(prompt).toContain("read, grep, find, ls");
  });

  it("windows an oversized buffer around the selection", () => {
    const lines = Array.from(
      { length: 5_000 },
      (_, index) => `line ${index + 1} ${"x".repeat(40)}`,
    );
    const prompt = buildInlineEditPrompt({
      filePath: "src/big.ts",
      instruction: "tweak",
      doc: lines.join("\n"),
      startLine: 2_500,
      endLine: 2_500,
    });
    expect(prompt).toContain("truncated around the selection");
    expect(prompt).toContain("2500\tline 2500");
    expect(prompt).not.toContain("\nline 1 ");
    expect(prompt.length).toBeLessThan(INLINE_EDIT_FILE_CHAR_LIMIT);
  });
});

describe("cleanInlineEditDraft", () => {
  it("strips a json fence and parses edits", () => {
    expect(
      cleanInlineEditDraft(
        '```json\n{"summary":"rename","edits":[{"oldText":"a","newText":"b"}]}\n```',
      ),
    ).toEqual({ summary: "rename", edits: [{ oldText: "a", newText: "b" }] });
  });

  it("keeps deletions but drops no-op and anchorless edits", () => {
    expect(
      cleanInlineEditDraft(
        '{"summary":"x","edits":[{"oldText":"a","newText":""},{"oldText":"b","newText":"b"},{"oldText":"","newText":"c"}]}',
      ),
    ).toEqual({ summary: "x", edits: [{ oldText: "a", newText: "" }] });
  });

  it("returns an empty edit list when the model refused", () => {
    expect(cleanInlineEditDraft('{"summary":"cannot do that","edits":[]}')).toEqual({
      summary: "cannot do that",
      edits: [],
    });
  });
});

describe("buildAskAiPrompt", () => {
  it("embeds the question, selected worktree, and read-only rules", () => {
    const prompt = buildAskAiPrompt({
      question: "Where is the command palette?",
      worktrees: [
        {
          title: "main",
          branch: "main",
          path: "/repo",
          selected: false,
        },
        {
          title: "feature",
          branch: "feat/x",
          path: "/repo/.pragma/worktrees/feat",
          selected: true,
        },
      ],
    });
    expect(prompt).toContain("Where is the command palette?");
    expect(prompt).toContain("currently selected in Pragma");
    expect(prompt).toContain("/repo/.pragma/worktrees/feat");
    expect(prompt).toContain("read-only tools");
    expect(prompt).toContain("cannot write files");
  });
});
