import type { CiWatch } from "@pragma-sh/constants";
import { describe, expect, it, vi } from "vitest";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";
import type { CiWatchUpdate } from "@/lib/tauri";
import {
  CI_WATCH_MAX_FIX_ATTEMPTS,
  CiWatchStore,
  isLiveCiWatch,
  type CiWatchEffects,
} from "./ci-watch-store";

const repo = {
  owner: "owner",
  repo: "repo",
  defaultBranch: "main",
  headBranch: "branch",
  parentBranch: null,
};

/** A host that behaves like `pragma-core::ci_watches`: terminal records reject updates. */
class FakeHost {
  records = new Map<string, CiWatch>();
  clock = 1;

  arm(overrides: Partial<CiWatch> = {}): CiWatch {
    const record: CiWatch = {
      worktreeId: "worktree",
      mode: "watchMerge",
      agentId: "agent",
      modelId: "model",
      reasoningId: null,
      prNumber: 1,
      status: "watching",
      attempts: 0,
      error: null,
      fixTabId: null,
      fixHeadSha: null,
      createdAt: 0,
      updatedAt: this.clock++,
      ...overrides,
    };
    this.records.set(record.worktreeId, record);
    return record;
  }

  update = async (worktreeId: string, changes: CiWatchUpdate): Promise<CiWatch> => {
    const record = this.records.get(worktreeId);
    if (!record) throw new Error("not found: no CI watch for worktree");
    if (!isLiveCiWatch(record)) throw new Error("stale write");
    const next = { ...record, ...changes, updatedAt: this.clock++ };
    this.records.set(worktreeId, next);
    return next;
  };

  disarm(reason: string): void {
    const record = this.records.get("worktree")!;
    this.records.set("worktree", {
      ...record,
      status: "disarmed",
      error: reason,
      updatedAt: this.clock++,
    });
  }

  get(): CiWatch | undefined {
    return this.records.get("worktree");
  }
}

function fixture(overrides: Partial<CiWatch> = {}) {
  const host = new FakeHost();
  host.arm(overrides);
  const store = new CiWatchStore();
  const pr = {
    number: 1,
    state: "open",
    headRef: "branch",
    headSha: "sha",
    merged: false,
    mergeable: true,
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
  const passing: ChecksStatus = {
    state: "success",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    items: checks.items.map((item) => ({ ...item, id: item.id! + 100, state: "success" })),
  };
  let tab = 0;
  const effects = {
    list: vi.fn(async () => ({ records: [...host.records.values()], complete: true })),
    repoFor: vi.fn(async () => repo),
    findPr: vi.fn(async () => pr),
    getPr: vi.fn().mockResolvedValue(pr),
    getChecks: vi.fn().mockResolvedValue(checks),
    getDetails: vi.fn().mockResolvedValue("lint: file.ts:12: Lint error"),
    agentFor: vi.fn(() => ({ id: "agent", name: "Agent", start: [], iconDataUrl: null })),
    launch: vi.fn<CiWatchEffects["launch"]>(async () => ({ id: `fix-tab-${++tab}` })),
    close: vi.fn().mockResolvedValue(undefined),
    merge: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(host.update),
    clear: vi.fn(async (worktreeId: string) => {
      host.records.delete(worktreeId);
    }),
    notify: vi.fn(),
  } satisfies CiWatchEffects;
  return { host, store, pr, checks, passing, effects };
}

/** Checks that look like CI restarted on the same commit (new run ids). */
function restarted(checks: ChecksStatus, round: number): ChecksStatus {
  return {
    ...checks,
    items: checks.items.map((item) => ({ ...item, id: item.id! + round * 10 })),
  };
}

describe("CI watch lifecycle", () => {
  it("launches the selected agent once with diagnostics, attempt count, and disarm instructions", async () => {
    const { host, store, effects } = fixture();
    await store.refresh(effects);
    await store.refresh(effects);
    expect(effects.launch).toHaveBeenCalledTimes(1);
    const prompt = effects.launch.mock.calls[0]![2] as string;
    expect(prompt).toContain("lint: file.ts:12: Lint error");
    expect(prompt).toContain("commit your changes and push");
    expect(prompt).toContain(`fix attempt 1 of ${CI_WATCH_MAX_FIX_ATTEMPTS}`);
    expect(prompt).toContain("pragma-cli ci disarm --reason");
    expect(prompt).toContain("cancels the pending merge");
    expect(host.get()).toMatchObject({ status: "fixing", attempts: 1, fixTabId: "fix-tab-1" });
    expect(store.get("worktree")?.record.status).toBe("fixing");
  });

  it("closes the fix tab when CI restarts, then launches the next attempt", async () => {
    const { host, store, checks, effects } = fixture();
    await store.refresh(effects);
    effects.getChecks.mockResolvedValue(restarted(checks, 1));
    await store.refresh(effects);
    expect(effects.close).toHaveBeenCalledExactlyOnceWith("fix-tab-1");
    expect(effects.launch).toHaveBeenCalledTimes(2);
    expect(host.get()).toMatchObject({ attempts: 2, fixTabId: "fix-tab-2" });
  });

  it(`gives up after ${CI_WATCH_MAX_FIX_ATTEMPTS} attempts and never merges`, async () => {
    const { host, store, checks, effects } = fixture();
    for (let round = 0; round <= CI_WATCH_MAX_FIX_ATTEMPTS; round++) {
      effects.getChecks.mockResolvedValue(restarted(checks, round));
      // eslint-disable-next-line no-await-in-loop -- each poll depends on the last.
      await store.refresh(effects);
    }
    expect(effects.launch).toHaveBeenCalledTimes(CI_WATCH_MAX_FIX_ATTEMPTS);
    expect(host.get()?.status).toBe("failed");
    expect(host.get()?.error).toContain(
      `still failing after ${CI_WATCH_MAX_FIX_ATTEMPTS} fix attempts`,
    );
    expect(host.get()?.error).toContain("lint");
    expect(effects.merge).not.toHaveBeenCalled();
    expect(effects.notify).toHaveBeenCalledWith("failed", expect.anything());
  });

  it("merges only once every check passes", async () => {
    const { host, store, passing, effects } = fixture();
    effects.getChecks.mockResolvedValue({ ...passing, state: "pending", pending: 1, passed: 1 });
    await store.refresh(effects);
    expect(effects.merge).not.toHaveBeenCalled();
    effects.getChecks.mockResolvedValue(passing);
    await store.refresh(effects);
    expect(effects.merge).toHaveBeenCalledTimes(1);
    expect(host.get()?.status).toBe("merged");
    expect(effects.notify).toHaveBeenCalledWith("merged", expect.anything());
  });

  it("does not merge in watch-only mode", async () => {
    const { host, store, passing, effects } = fixture({ mode: "watch" });
    effects.getChecks.mockResolvedValue(passing);
    await store.refresh(effects);
    expect(effects.merge).not.toHaveBeenCalled();
    expect(host.get()?.status).toBe("watching");
  });

  it("records GitHub's merge rejection as a failure", async () => {
    const { host, store, passing, effects } = fixture();
    effects.getChecks.mockResolvedValue(passing);
    effects.merge.mockRejectedValue(new Error("At least 1 approving review is required"));
    await store.refresh(effects);
    expect(host.get()?.status).toBe("failed");
    expect(host.get()?.error).toContain("At least 1 approving review is required");
  });

  it("stops at once when disarmed from the CLI, keeping the full reason", async () => {
    const { host, store, effects } = fixture();
    await store.refresh(effects);
    host.disarm("The deploy check needs a production secret.\nThis branch cannot fix it.");
    await store.refresh(effects);
    expect(effects.launch).toHaveBeenCalledTimes(1);
    expect(store.get("worktree")?.record).toMatchObject({
      status: "disarmed",
      error: "The deploy check needs a production secret.\nThis branch cannot fix it.",
    });
  });

  it("closes a tab that opened after a disarm raced the launch", async () => {
    const { host, store, effects } = fixture();
    effects.launch.mockImplementationOnce(async () => {
      host.disarm("cannot fix");
      return { id: "late-tab" };
    });
    await store.refresh(effects);
    expect(effects.close).toHaveBeenCalledWith("late-tab");
    expect(store.get("worktree")?.error).toBeUndefined();
  });

  it("resolves the PR of a watch armed from the CLI", async () => {
    const { host, store, effects } = fixture({ prNumber: null });
    await store.refresh(effects);
    expect(effects.findPr).toHaveBeenCalled();
    expect(host.get()?.prNumber).toBe(1);
  });

  it("clears the watch when the PR closes", async () => {
    const { host, store, pr, effects } = fixture();
    effects.getPr.mockResolvedValue({ ...pr, state: "closed" });
    await store.refresh(effects);
    expect(effects.launch).not.toHaveBeenCalled();
    expect(host.get()).toBeUndefined();
  });

  it("shows a transient GitHub error and recovers", async () => {
    const { store, effects } = fixture();
    effects.getPr.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await store.refresh(effects);
    expect(store.get("worktree")?.error).toBe("GitHub unavailable");
    await Promise.all([store.refresh(effects), store.refresh(effects)]);
    expect(effects.launch).toHaveBeenCalledTimes(1);
    expect(store.get("worktree")?.error).toBeUndefined();
  });

  it("falls back to check summaries if annotations cannot be fetched", async () => {
    const { store, effects } = fixture();
    effects.getDetails.mockRejectedValue(new Error("Forbidden"));
    await store.refresh(effects);
    expect(effects.launch.mock.calls[0]![2]).toContain("Lint error");
  });

  it("drops local watches the host no longer has", async () => {
    const { host, store, effects } = fixture();
    await store.refresh(effects);
    host.records.clear();
    await store.refresh(effects);
    expect(store.get("worktree")).toBeUndefined();
  });
});
