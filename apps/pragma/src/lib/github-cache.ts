/**
 * In-memory stale-while-revalidate cache for GitHub REST/GraphQL reads.
 *
 * Fresh hits return immediately. Stale hits return the cached value and kick a
 * background refetch so the next caller (or a subscriber) sees fresher data
 * without blocking the UI. Concurrent fetches for the same key coalesce.
 */

export type GitHubPrLifecycle = "open" | "draft" | "merged" | "closed" | "merging" | "none";

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const store = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

/** Subscribe to cache writes for `key`. Returns an unsubscribe. */
export function subscribeGitHubCache(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Synchronous peek — returns undefined when missing (expired entries still return). */
export function peekGitHubCache<T>(key: string): T | undefined {
  const entry = store.get(key);
  return entry ? (entry.value as T) : undefined;
}

/** Drops one key, every key with a prefix, or the whole cache. */
export function invalidateGitHubCache(keyOrPrefix?: string): void {
  if (keyOrPrefix === undefined) {
    store.clear();
    for (const key of listeners.keys()) notify(key);
    return;
  }
  if (store.has(keyOrPrefix)) {
    store.delete(keyOrPrefix);
    notify(keyOrPrefix);
  }
  for (const key of store.keys()) {
    if (key.startsWith(keyOrPrefix)) {
      store.delete(key);
      notify(key);
    }
  }
}

/**
 * Read-through cache. Fresh → return. Stale → return + background refresh.
 * Miss → await fetch. `force` always awaits a new fetch.
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: { ttlMs?: number; force?: boolean },
): Promise<T> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const force = options?.force ?? false;
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;

  if (!force && existing && now - existing.fetchedAt < ttlMs) {
    return existing.value;
  }

  if (!force && existing) {
    void revalidate(key, fetcher);
    return existing.value;
  }

  return revalidate(key, fetcher);
}

async function revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const request = fetcher()
    .then((value) => {
      store.set(key, { value, fetchedAt: Date.now() });
      notify(key);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Cache key helpers — keep wire format stable across call sites. */
export function githubCacheKeys(repo: { owner: string; repo: string }) {
  const base = `${repo.owner}/${repo.repo}`;
  return {
    pr: (n: number) => `pr:${base}#${n}`,
    prForBranch: (branch: string) => `pr-branch:${base}:${branch}`,
    comments: (n: number) => `comments:${base}#${n}`,
    commits: (n: number) => `commits:${base}#${n}`,
    files: (n: number) => `files:${base}#${n}`,
    reviews: (n: number) => `reviews:${base}#${n}`,
    threads: (n: number) => `threads:${base}#${n}`,
    checks: (ref: string) => `checks:${base}@${ref}`,
    branches: (owner: string, name: string) => `branches:${owner}/${name}`,
    baseRepos: (owner: string, name: string) => `base-repos:${owner}/${name}`,
  };
}

/** Test helper — wipes every entry and listener. */
export function resetGitHubCacheForTests(): void {
  store.clear();
  inFlight.clear();
  listeners.clear();
}
