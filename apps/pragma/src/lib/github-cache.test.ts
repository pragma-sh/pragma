import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedFetch,
  invalidateGitHubCache,
  peekGitHubCache,
  resetGitHubCacheForTests,
  subscribeGitHubCache,
} from "./github-cache";

beforeEach(() => {
  resetGitHubCacheForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetGitHubCacheForTests();
});

describe("cachedFetch", () => {
  it("fetches on miss and serves the cached value while fresh", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    await expect(cachedFetch("k", fetcher, { ttlMs: 10_000 })).resolves.toBe("v1");
    await expect(cachedFetch("k", fetcher, { ttlMs: 10_000 })).resolves.toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns stale value immediately and revalidates in the background", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    await cachedFetch("k", fetcher, { ttlMs: 1_000 });
    vi.advanceTimersByTime(2_000);
    await expect(cachedFetch("k", fetcher, { ttlMs: 1_000 })).resolves.toBe("v1");
    // Background revalidate is in flight.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await expect(cachedFetch("k", fetcher, { ttlMs: 1_000 })).resolves.toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent misses into one fetch", async () => {
    let resolve!: (value: string) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const a = cachedFetch("k", fetcher);
    const b = cachedFetch("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve("shared");
    await expect(Promise.all([a, b])).resolves.toEqual(["shared", "shared"]);
  });

  it("force bypasses the cache", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    await cachedFetch("k", fetcher);
    await expect(cachedFetch("k", fetcher, { force: true })).resolves.toBe("b");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers on write and supports invalidate", async () => {
    const listener = vi.fn();
    const stop = subscribeGitHubCache("k", listener);
    await cachedFetch("k", async () => 1);
    expect(listener).toHaveBeenCalled();
    expect(peekGitHubCache<number>("k")).toBe(1);
    invalidateGitHubCache("k");
    expect(peekGitHubCache("k")).toBeUndefined();
    stop();
  });
});
