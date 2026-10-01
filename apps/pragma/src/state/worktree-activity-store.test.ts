import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  trackWorktreeActivity,
  useLatestWorktreeActivity,
  worktreeActivityLabel,
} from "@/state/worktree-activity-store";
import { deferred } from "@/test/deferred";

describe("trackWorktreeActivity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await act(() => vi.runAllTimersAsync());
    vi.useRealTimers();
  });

  it("reports the action while it runs, then briefly as done", async () => {
    const push = deferred<string>();
    const { result } = renderHook(() => useLatestWorktreeActivity("wt-1"));
    let promise: Promise<string> = Promise.resolve("");
    act(() => {
      promise = trackWorktreeActivity("wt-1", "push", () => push.promise);
    });
    expect(result.current?.state).toBe("running");
    expect(worktreeActivityLabel(result.current!)).toBe("Pushing");

    await act(async () => {
      push.resolve("ok");
      await expect(promise).resolves.toBe("ok");
    });
    expect(result.current?.state).toBe("done");
    expect(worktreeActivityLabel(result.current!)).toBe("Pushed");

    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(result.current).toBeNull();
  });

  it("rethrows a failure and keeps it visible longer", async () => {
    const { result } = renderHook(() => useLatestWorktreeActivity("wt-2"));
    await act(async () => {
      await expect(
        trackWorktreeActivity("wt-2", "create-pr", () => Promise.reject(new Error("nope"))),
      ).rejects.toThrow("nope");
    });
    expect(result.current?.state).toBe("failed");
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(result.current?.state).toBe("failed");
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(result.current).toBeNull();
  });

  it("shows the newest action per worktree", async () => {
    const { result } = renderHook(() => useLatestWorktreeActivity("wt-3"));
    act(() => {
      void trackWorktreeActivity("wt-3", "commit-and-draft", () => new Promise(() => {}));
      void trackWorktreeActivity("wt-3", "push", () => new Promise(() => {}));
    });
    expect(result.current?.kind).toBe("push");
  });
});
