import { describe, expect, it, vi } from "vitest";
import { CiWatchStore, ciWatchKey, type CiWatch, type CiWatchEffects } from "./ci-watch-store";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";

function fixture() {
  const store = new CiWatchStore();
  const watch: CiWatch = {
    worktreeId: "worktree",
    repo: {
      owner: "owner",
      repo: "repo",
      defaultBranch: "main",
      headBranch: "branch",
      parentBranch: null,
    },
    prNumber: 1,
    headRef: "branch",
    agent: { id: "agent", name: "Agent", start: [], iconDataUrl: null },
    modelSelection: { modelId: "model", reasoningId: null },
    modelLabel: "Model",
    phase: "watching",
  };
  const pr = {
    state: "open",
    headRef: "branch",
    headSha: "sha",
    merged: false,
  } as PullRequestSummary;
  const checks: ChecksStatus = {
    state: "failure",
    total: 2,
    passed: 0,
    failed: 1,
    pending: 1,
    items: [
      {
        id: 1,
        name: "lint",
        state: "failure",
        url: "https://example.com/check",
        description: "Lint error",
      },
      { id: 2, name: "test", state: "pending", url: null },
    ],
  };
  const effects = {
    getPr: vi.fn().mockResolvedValue(pr),
    getChecks: vi.fn().mockResolvedValue(checks),
    getDetails: vi.fn().mockResolvedValue("lint: file.ts:12: Lint error"),
    launch: vi.fn().mockResolvedValue({ id: "fix-tab" }),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies CiWatchEffects;
  store.set("key", watch);
  return { store, watch, pr, checks, effects };
}

describe("CI watch lifecycle", () => {
  it("launches the selected harness once with diagnostics and commit/push instructions", async () => {
    const { store, watch, effects } = fixture();
    await store.refresh(effects);
    await store.refresh(effects);
    expect(effects.launch).toHaveBeenCalledTimes(1);
    expect(effects.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: watch.agent, modelSelection: watch.modelSelection }),
      expect.stringContaining("lint: file.ts:12: Lint error"),
    );
    expect(effects.launch.mock.calls[0]![1]).toContain("commit your changes and push");
    expect(effects.close).not.toHaveBeenCalled(); // Existing pending jobs are not a restart.
    expect(store.get("key")?.phase).toBe("fixing");
  });

  it("waits for checks on the new head, closes only its tab, then watches the next cycle", async () => {
    const { store, pr, checks, effects } = fixture();
    await store.refresh(effects);
    effects.getPr.mockResolvedValue({ ...pr, headSha: "new-sha" });
    effects.getChecks.mockResolvedValue({ ...checks, total: 0, items: [], failed: 0, pending: 0 });
    await store.refresh(effects);
    expect(effects.close).not.toHaveBeenCalled();
    effects.getChecks.mockResolvedValue({
      ...checks,
      state: "pending",
      failed: 0,
      pending: 2,
      items: checks.items.map((item) =>
        Object.assign({}, item, { id: item.id! + 10, state: "pending" }),
      ),
    });
    await store.refresh(effects);
    expect(effects.close).toHaveBeenCalledExactlyOnceWith("fix-tab");
    expect(store.get("key")?.phase).toBe("watching");
    effects.getChecks.mockResolvedValue({
      ...checks,
      items: checks.items.map((item) => Object.assign({}, item, { id: item.id! + 10 })),
    });
    await store.refresh(effects);
    expect(effects.launch).toHaveBeenCalledTimes(2);
  });

  it("detects same-commit reruns without treating unrelated job completions as restarts", async () => {
    const { store, checks, effects } = fixture();
    await store.refresh(effects);
    effects.getChecks.mockResolvedValue({
      ...checks,
      pending: 0,
      passed: 1,
      items: [checks.items[0]!, { ...checks.items[1]!, state: "success" }],
    });
    await store.refresh(effects);
    expect(effects.close).not.toHaveBeenCalled();
    effects.getChecks.mockResolvedValue({
      ...checks,
      failed: 0,
      pending: 2,
      items: checks.items.map((item) => Object.assign({}, item, { state: "pending" })),
    });
    await store.refresh(effects);
    expect(effects.close).toHaveBeenCalledExactlyOnceWith("fix-tab");
  });

  it("does not close the fix tab when an original queued job starts", async () => {
    const { store, checks, effects } = fixture();
    await store.refresh(effects);
    effects.getChecks.mockResolvedValue({
      ...checks,
      items: [
        checks.items[0],
        Object.assign({}, checks.items[1], { startedAt: "2026-10-29T12:00:00Z" }),
      ],
    });
    await store.refresh(effects);
    expect(effects.close).not.toHaveBeenCalled();
    expect(effects.launch).toHaveBeenCalledTimes(1);
  });

  it("recognizes a same-id rerun that finishes between polls", async () => {
    const { store, checks, effects } = fixture();
    await store.refresh(effects);
    effects.getChecks.mockResolvedValue({
      ...checks,
      items: [
        Object.assign({}, checks.items[0], { startedAt: "2026-10-29T12:00:00Z" }),
        checks.items[1],
      ],
    });
    await store.refresh(effects);
    expect(effects.close).toHaveBeenCalledExactlyOnceWith("fix-tab");
    expect(effects.launch).toHaveBeenCalledTimes(2);
  });

  it("cancels safely while diagnostics are in flight", async () => {
    const { store, effects } = fixture();
    let resolve!: (details: string) => void;
    effects.getDetails.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const refresh = store.refresh(effects);
    await vi.waitFor(() => expect(effects.getDetails).toHaveBeenCalled());
    store.cancel("key");
    resolve("late diagnostics");
    await refresh;
    expect(effects.launch).not.toHaveBeenCalled();
    expect(store.get("key")).toBeUndefined();
  });

  it("ignores overlapping ticks and recovers from a transient GitHub error", async () => {
    const { store, effects } = fixture();
    effects.getPr.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await store.refresh(effects);
    expect(store.get("key")?.error).toBe("GitHub unavailable");
    await Promise.all([store.refresh(effects), store.refresh(effects)]);
    expect(effects.launch).toHaveBeenCalledTimes(1);
    expect(store.get("key")?.error).toBeUndefined();
  });

  it("falls back to check summaries if annotations cannot be fetched", async () => {
    const { store, effects } = fixture();
    effects.getDetails.mockRejectedValue(new Error("Forbidden"));
    await store.refresh(effects);
    expect(effects.launch.mock.calls[0]![1]).toContain("Lint error");
  });

  it("stops watching when the PR closes", async () => {
    const { store, pr, effects } = fixture();
    effects.getPr.mockResolvedValue({ ...pr, state: "closed" });
    await store.refresh(effects);
    expect(effects.launch).not.toHaveBeenCalled();
    expect(store.get("key")).toBeUndefined();
  });

  it("isolates watches for identically numbered PRs", () => {
    const { watch } = fixture();
    expect(ciWatchKey("a", watch.repo, 1)).not.toBe(ciWatchKey("b", watch.repo, 1));
    expect(ciWatchKey("a", watch.repo, 1)).not.toBe(
      ciWatchKey("a", { ...watch.repo, repo: "other" }, 1),
    );
  });
});
