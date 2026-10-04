import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMergeSettle } from "@/components/right-sidebar/use-merge-settle";
import type { PullRequestSummary } from "@/lib/github";

function summary(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return { headSha: "old", mergeable: false, ...overrides } as PullRequestSummary;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMergeSettle", () => {
  it("passes summaries through when nothing was pushed", () => {
    const { result } = renderHook(() => useMergeSettle());
    expect(result.current.apply(summary({})).mergeable).toBe(false);
  });

  it("shows the PR mergeable until GitHub reports the new head, then stops polling", async () => {
    const { result } = renderHook(() => useMergeSettle());
    const reload = vi.fn(() => Promise.resolve());

    let shown: PullRequestSummary | undefined;
    act(() => {
      shown = result.current.start(summary({}), reload);
    });
    expect(shown?.mergeable).toBe(true);
    // Stale reads — the old head, or the new one still computing — stay mergeable.
    expect(result.current.apply(summary({})).mergeable).toBe(true);
    expect(result.current.apply(summary({ headSha: "new", mergeable: null })).mergeable).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(reload).toHaveBeenCalledTimes(1);

    // GitHub settled: its answer wins, even when it still conflicts.
    expect(result.current.apply(summary({ headSha: "new", mergeable: false })).mergeable).toBe(
      false,
    );
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives up overriding after the last poll", async () => {
    const { result } = renderHook(() => useMergeSettle());
    const reload = vi.fn(() => Promise.resolve());
    act(() => {
      result.current.start(summary({}), reload);
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reload).toHaveBeenCalledTimes(6);
    expect(result.current.apply(summary({})).mergeable).toBe(false);
  });
});
