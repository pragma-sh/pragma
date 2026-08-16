import { describe, expect, it } from "vitest";

import type { ReviewThread } from "@/lib/github";
import type { FixItComment } from "@/state/fix-it-store";

import {
  buildListFixPrompt,
  buildSingleFixPrompt,
  commentLocation,
  reviewThreadToFixItComment,
} from "./fix-it-prompt";

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "thr1",
    path: "src/app.ts",
    line: 12,
    isResolved: false,
    comments: [
      { id: 1, body: " first ", createdAt: "", user: null },
      { id: 2, body: "second", createdAt: "", user: null },
    ],
    ...overrides,
  };
}

describe("reviewThreadToFixItComment", () => {
  it("joins trimmed, non-empty comment bodies", () => {
    expect(reviewThreadToFixItComment(thread()).body).toBe("first\n\nsecond");
  });

  it("carries the thread id, path and line", () => {
    const comment = reviewThreadToFixItComment(thread());
    expect(comment).toMatchObject({ threadId: "thr1", path: "src/app.ts", line: 12 });
  });
});

describe("commentLocation", () => {
  const base: FixItComment = { threadId: "t", path: "a.ts", line: 5, body: "x" };

  it("includes the line when present", () => {
    expect(commentLocation(base)).toBe("a.ts:5");
  });

  it("omits the line when null", () => {
    expect(commentLocation({ ...base, line: null })).toBe("a.ts");
  });
});

describe("buildSingleFixPrompt", () => {
  it("quotes the comment and references its location", () => {
    const prompt = buildSingleFixPrompt({ threadId: "t", path: "a.ts", line: 5, body: "fix me" });
    expect(prompt).toContain("Verify and fix a code review issue.");
    expect(prompt).toContain("`a.ts:5`");
    expect(prompt).toContain("> fix me");
  });
});

describe("buildListFixPrompt", () => {
  it("numbers and quotes every comment", () => {
    const prompt = buildListFixPrompt([
      { threadId: "t1", path: "a.ts", line: 5, body: "one" },
      { threadId: "t2", path: "b.ts", line: null, body: "two" },
    ]);
    expect(prompt).toContain("Verify and fix all of the following code review issues.");
    expect(prompt).toContain("1. `a.ts:5`:");
    expect(prompt).toContain("> one");
    expect(prompt).toContain("2. `b.ts`:");
    expect(prompt).toContain("> two");
    expect(prompt).not.toContain("commit all resulting changes");
  });

  it("appends commit and push instructions when requested", () => {
    const prompt = buildListFixPrompt([{ threadId: "t1", path: "a.ts", line: 5, body: "one" }], {
      commitAndPush: true,
    });

    expect(prompt).toContain(
      "After addressing all applicable issues, commit all resulting changes and push the current branch.",
    );
  });
});
