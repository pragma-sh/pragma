import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("startRefreshLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentHidden(false);
  });

  afterEach(() => {
    setDocumentHidden(false);
    vi.useRealTimers();
  });

  it("refreshes immediately and on each interval tick", () => {
    const refresh = vi.fn();
    const stop = startRefreshLoop(refresh, 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips interval ticks while the document is hidden", () => {
    const refresh = vi.fn();
    const stop = startRefreshLoop(refresh, 1000);
    setDocumentHidden(true);
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    setDocumentHidden(false);
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("refreshes on window focus and stops cleanly", () => {
    const refresh = vi.fn();
    const stop = startRefreshLoop(refresh, 1000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(5000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not start another refresh while one is in flight", async () => {
    let finishRefresh: (() => void) | undefined;
    const pendingRefresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refresh = vi.fn().mockReturnValueOnce(pendingRefresh).mockResolvedValue(undefined);
    const stop = startRefreshLoop(refresh, 1000);

    vi.advanceTimersByTime(3000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);

    finishRefresh?.();
    await pendingRefresh;
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});
