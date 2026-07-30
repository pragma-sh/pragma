import type { FileChange } from "@pragma/constants";
import type { Channel } from "@tauri-apps/api/core";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watchWorktreeFilesMock = vi.fn();
const stopWatchingWorktreeFilesMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  stopWatchingWorktreeFiles: (...args: unknown[]) => stopWatchingWorktreeFilesMock(...args),
  watchWorktreeFiles: (...args: unknown[]) => watchWorktreeFilesMock(...args),
}));

import { subscribeToWorktreeFiles, useWorktreeFileChange } from "./file-watch";

// Each call to watchWorktreeFiles records the dispatch callback so tests can
// push synthetic FileChanges through the same path the Tauri channel would.
const dispatchers = new Map<string, (change: FileChange) => void>();

beforeEach(() => {
  dispatchers.clear();
  watchWorktreeFilesMock.mockReset();
  stopWatchingWorktreeFilesMock.mockReset().mockResolvedValue(undefined);
  watchWorktreeFilesMock.mockImplementation(
    (worktreeId: string, onChange: (change: FileChange) => void) => {
      dispatchers.set(worktreeId, onChange);
      return Promise.resolve({
        channel: { onmessage: onChange } as Channel<FileChange>,
        subscriptionId: dispatchers.size,
      });
    },
  );
});

afterEach(() => {
  // Drain any leftover listeners so worktree channels from one test don't leak
  // into the next (the registry intentionally keeps channels for the session).
  for (const worktreeId of dispatchers.keys()) {
    dispatchers.get(worktreeId)?.({ path: "__drain__", kind: "modified" });
  }
});

describe("subscribeToWorktreeFiles", () => {
  it("opens a single channel per worktree and fans out to all listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = subscribeToWorktreeFiles("wt-fanout", a);
    const unsubscribeB = subscribeToWorktreeFiles("wt-fanout", b);

    expect(watchWorktreeFilesMock).toHaveBeenCalledTimes(1);

    const change: FileChange = { path: "src/app.ts", kind: "modified" };
    dispatchers.get("wt-fanout")?.(change);

    expect(a).toHaveBeenCalledWith(change);
    expect(b).toHaveBeenCalledWith(change);
    unsubscribeA();
    unsubscribeB();
  });

  it("stops delivery and closes the native stream after the last unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWorktreeFiles("wt-unsub", listener);

    dispatchers.get("wt-unsub")?.({ path: "a.ts", kind: "created" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    dispatchers.get("wt-unsub")?.({ path: "a.ts", kind: "modified" });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stopWatchingWorktreeFilesMock).toHaveBeenCalledWith(1));
  });

  it("opens a distinct channel per worktree", () => {
    const unsubscribeOne = subscribeToWorktreeFiles("wt-one", vi.fn());
    const unsubscribeTwo = subscribeToWorktreeFiles("wt-two", vi.fn());

    expect(watchWorktreeFilesMock).toHaveBeenCalledTimes(2);
    unsubscribeOne();
    unsubscribeTwo();
  });
});

describe("useWorktreeFileChange", () => {
  it("invokes the latest handler with each change while mounted", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useWorktreeFileChange("wt-hook", handler));

    const change: FileChange = { path: "src/new.ts", kind: "created" };
    dispatchers.get("wt-hook")?.(change);

    expect(handler).toHaveBeenCalledWith(change);
    unmount();
  });

  it("is a no-op for an empty worktree id", () => {
    renderHook(() => useWorktreeFileChange("", vi.fn()));

    expect(watchWorktreeFilesMock).not.toHaveBeenCalled();
  });
});
