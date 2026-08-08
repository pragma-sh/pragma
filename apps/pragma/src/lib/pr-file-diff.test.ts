import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetGitHubCacheForTests } from "./github-cache";
import { fileDiffsEqual, loadPrFileDiff, prFileDiffCacheKey } from "./pr-file-diff";

const githubPrFileDiff = vi.fn();

vi.mock("@/lib/tauri", () => ({
  githubPrFileDiff: (...args: unknown[]) => githubPrFileDiff(...args),
}));

beforeEach(() => {
  resetGitHubCacheForTests();
  githubPrFileDiff.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetGitHubCacheForTests();
});

describe("prFileDiffCacheKey", () => {
  it("includes worktree, base, path, and oldPath", () => {
    expect(prFileDiffCacheKey("w", "main", "a.ts", "old/a.ts")).toBe(
      "pr-file-diff:w:main:a.ts:old/a.ts",
    );
    expect(prFileDiffCacheKey("w", "main", "a.ts", null)).toBe("pr-file-diff:w:main:a.ts:");
  });
});

describe("loadPrFileDiff", () => {
  it("caches hits and revalidates stale entries in the background", async () => {
    githubPrFileDiff
      .mockResolvedValueOnce({ path: "f.ts", oldText: "a", newText: "b", binary: false })
      .mockResolvedValueOnce({ path: "f.ts", oldText: "a", newText: "c", binary: false });

    const first = await loadPrFileDiff("w", "main", "f.ts");
    expect(first.newText).toBe("b");
    await expect(loadPrFileDiff("w", "main", "f.ts")).resolves.toEqual(first);
    expect(githubPrFileDiff).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(11_000);
    await expect(loadPrFileDiff("w", "main", "f.ts")).resolves.toEqual(first);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await expect(loadPrFileDiff("w", "main", "f.ts")).resolves.toMatchObject({ newText: "c" });
    expect(githubPrFileDiff).toHaveBeenCalledTimes(2);
  });
});

describe("fileDiffsEqual", () => {
  it("compares binary and both sides of the diff", () => {
    const base = { path: "f.ts", oldText: "a", newText: "b", binary: false };
    expect(fileDiffsEqual(null, base)).toBe(false);
    expect(fileDiffsEqual(base, base)).toBe(true);
    expect(fileDiffsEqual(base, { ...base, newText: "c" })).toBe(false);
  });
});
