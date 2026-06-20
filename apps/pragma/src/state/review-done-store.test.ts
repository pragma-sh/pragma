import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isReviewDone, setReviewDone, useReviewDone } from "./review-done-store";

afterEach(() => {
  // The store is module-global; reset any keys touched by a test.
  setReviewDone(1, "a.ts", false);
  setReviewDone(1, "b.ts", false);
  setReviewDone(2, "a.ts", false);
});

describe("review-done-store", () => {
  it("toggles a file's done state keyed by prNumber:path", () => {
    expect(isReviewDone(1, "a.ts")).toBe(false);
    setReviewDone(1, "a.ts", true);
    expect(isReviewDone(1, "a.ts")).toBe(true);
    setReviewDone(1, "a.ts", false);
    expect(isReviewDone(1, "a.ts")).toBe(false);
  });

  it("isolates files and PRs from each other", () => {
    setReviewDone(1, "a.ts", true);
    expect(isReviewDone(1, "b.ts")).toBe(false);
    expect(isReviewDone(2, "a.ts")).toBe(false);
  });

  it("notifies subscribers through the hook", () => {
    const { result } = renderHook(() => useReviewDone(1, "a.ts"));
    expect(result.current).toBe(false);
    act(() => setReviewDone(1, "a.ts", true));
    expect(result.current).toBe(true);
  });
});
