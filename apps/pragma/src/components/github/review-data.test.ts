import type { GitHubRepoRef } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import type { PullFile, PullRequestSummary, ReviewThread } from "@/lib/github";

import {
  type ReviewData,
  buildCommentKeys,
  groupThreadsByPath,
  reuseUnchangedReviewData,
  reviewDataSignature,
} from "./review-data";

function file(path: string, additions = 1): PullFile {
  return { path, oldPath: null, status: "modified", additions, deletions: 0 };
}

function thread(id: string, path: string, body = "hi"): ReviewThread {
  return {
    id,
    path,
    line: 1,
    isResolved: false,
    comments: [{ id: 1, body, createdAt: "", user: null }],
  } as ReviewThread;
}

function data(files: PullFile[], threads: ReviewThread[]): ReviewData {
  return {
    repo: { owner: "o", repo: "r" } as GitHubRepoRef,
    pr: { number: 1 } as PullRequestSummary,
    files,
    reviews: [],
    threadsByPath: groupThreadsByPath(threads),
  };
}

describe("buildCommentKeys", () => {
  it("orders thread ids by file order, not thread order", () => {
    const threads = [thread("b1", "b.ts"), thread("a1", "a.ts"), thread("a2", "a.ts")];
    expect(buildCommentKeys([file("a.ts"), file("b.ts")], groupThreadsByPath(threads))).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
  });
});

describe("reuseUnchangedReviewData", () => {
  it("keeps references for untouched files and thread lists", () => {
    const prev = data([file("a.ts"), file("b.ts")], [thread("a1", "a.ts"), thread("b1", "b.ts")]);
    const next = data(
      [file("a.ts"), file("b.ts", 5)],
      [thread("a1", "a.ts"), thread("b1", "b.ts", "edited")],
    );
    const merged = reuseUnchangedReviewData(prev, next);

    expect(merged.files[0]).toBe(prev.files[0]);
    expect(merged.files[1]).toBe(next.files[1]);
    expect(merged.threadsByPath.get("a.ts")).toBe(prev.threadsByPath.get("a.ts"));
    expect(merged.threadsByPath.get("b.ts")).toBe(next.threadsByPath.get("b.ts"));
    expect(reviewDataSignature(merged)).toBe(reviewDataSignature(next));
  });

  it("drops files and threads that disappeared", () => {
    const prev = data([file("a.ts"), file("b.ts")], [thread("a1", "a.ts"), thread("b1", "b.ts")]);
    const merged = reuseUnchangedReviewData(prev, data([file("a.ts")], [thread("a1", "a.ts")]));
    expect(merged.files.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect([...merged.threadsByPath.keys()]).toEqual(["a.ts"]);
  });
});
