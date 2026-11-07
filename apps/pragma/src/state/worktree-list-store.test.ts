import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorktreeListStore } from "./worktree-list-store";

describe("createWorktreeListStore", () => {
  it("shares one fetch between every reader of a worktree", async () => {
    const load = vi.fn(async (id: string) => [id]);
    const store = createWorktreeListStore(load);

    const first = renderHook(() => store.useList("wt-1"));
    const second = renderHook(() => store.useList("wt-1"));

    await waitFor(() => expect(first.result.current).toEqual(["wt-1"]));
    expect(second.result.current).toEqual(["wt-1"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("reads null before the first load settles and empty after a failed one", async () => {
    const rejects: Array<(cause: Error) => void> = [];
    const store = createWorktreeListStore<string>(
      () =>
        new Promise((_, reject) => {
          rejects.push(reject);
        }),
    );

    const { result } = renderHook(() => store.useList("wt-1"));
    expect(result.current).toBeNull();

    await act(async () => rejects[0]?.(new Error("gone")));
    expect(result.current).toEqual([]);
  });

  it("re-fetches once more when invalidated mid-load", async () => {
    const resolvers: Array<(items: number[]) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const store = createWorktreeListStore(load);
    const { result } = renderHook(() => store.useList("wt-1"));

    store.invalidate("wt-1");
    store.invalidate("wt-1");
    await act(async () => resolvers[0]?.([1]));
    expect(load).toHaveBeenCalledTimes(2);
    // The out-of-date first result is never shown.
    expect(result.current).toBeNull();

    await act(async () => resolvers[1]?.([2]));
    expect(result.current).toEqual([2]);
  });

  it("forgets an unread worktree when it is invalidated", async () => {
    const load = vi.fn(async () => ["a"]);
    const store = createWorktreeListStore(load);
    const reader = renderHook(() => store.useList("wt-1"));
    await waitFor(() => expect(reader.result.current).toEqual(["a"]));
    reader.unmount();

    store.invalidate("wt-1");
    expect(load).toHaveBeenCalledOnce();

    const next = renderHook(() => store.useList("wt-1"));
    expect(next.result.current).toBeNull();
    await waitFor(() => expect(next.result.current).toEqual(["a"]));
  });

  describe("with pollMs", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("picks up items written elsewhere while read, and stops once unread", async () => {
      vi.useFakeTimers();
      let items = ["a"];
      const load = vi.fn(async () => items);
      const store = createWorktreeListStore(load, { pollMs: 1000 });
      const { result, unmount } = renderHook(() => store.useList("wt-1"));
      await act(async () => {});
      expect(result.current).toEqual(["a"]);

      items = ["a", "b"];
      await act(async () => vi.advanceTimersByTime(1000));
      expect(result.current).toEqual(["a", "b"]);

      unmount();
      const calls = load.mock.calls.length;
      await act(async () => vi.advanceTimersByTime(5000));
      expect(load).toHaveBeenCalledTimes(calls);
    });

    it("keeps the same list (no re-render) when a poll finds nothing new", async () => {
      vi.useFakeTimers();
      const store = createWorktreeListStore(async () => ["a"], { pollMs: 1000 });
      const { result } = renderHook(() => store.useList("wt-1"));
      await act(async () => {});
      const first = result.current;

      await act(async () => vi.advanceTimersByTime(1000));
      expect(result.current).toBe(first);
    });

    it("re-fetches as soon as the window regains focus", async () => {
      let items = ["a"];
      const store = createWorktreeListStore(async () => items, { pollMs: 60_000 });
      const { result } = renderHook(() => store.useList("wt-1"));
      await waitFor(() => expect(result.current).toEqual(["a"]));

      items = ["b"];
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(result.current).toEqual(["b"]));
    });
  });
});
