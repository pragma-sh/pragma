import type { Project } from "@pragma-sh/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestSummary } from "@/lib/github";
import { listAllCiWatches, prepareMerge } from "./ci-watch-effects";

const tauri = vi.hoisted(() => ({ listWorktrees: vi.fn(), listCiWatches: vi.fn() }));
const github = vi.hoisted(() => ({
  getPullRequestStack: vi.fn(),
  mergePullRequest: vi.fn(),
  mergePullRequestStack: vi.fn(),
}));
vi.mock("@/lib/tauri", () => tauri);
vi.mock("@/lib/github", () => github);

const repo = {
  owner: "owner",
  repo: "repo",
  defaultBranch: "main",
  headBranch: "branch",
  parentBranch: null,
};
const pr = { number: 1, headSha: "checked" } as PullRequestSummary;

beforeEach(() => vi.resetAllMocks());

describe("listAllCiWatches", () => {
  it("asks every registered project and reports the hosts that failed", async () => {
    tauri.listWorktrees.mockImplementation(async (id: string) => [{ id: `${id}-worktree` }]);
    tauri.listCiWatches.mockImplementation(async (via: string) => {
      if (via === "b-worktree") throw new Error("offline");
      return [{ worktreeId: via }];
    });
    const listing = await listAllCiWatches([{ id: "a" }, { id: "b" }] as Project[]);
    expect(listing.records).toEqual([{ worktreeId: "a-worktree" }]);
    expect([...listing.unanswered]).toEqual(["b-worktree"]);
  });
});

describe("prepareMerge", () => {
  it("pins the checked commit", async () => {
    github.getPullRequestStack.mockResolvedValue(null);
    const send = await prepareMerge(repo, pr);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    await send?.();
    expect(github.mergePullRequest).toHaveBeenCalledWith(repo, 1, "merge", "checked");
  });

  it("pins a stack merge to its top head", async () => {
    const stack = {
      entries: [
        { number: 1, headSha: "checked" },
        { number: 2, headSha: "top" },
      ],
    };
    github.getPullRequestStack.mockResolvedValue(stack);
    await (
      await prepareMerge(repo, pr)
    )?.();
    expect(github.mergePullRequestStack).toHaveBeenCalledWith(repo, stack, "top");
  });

  it("refuses a stack that already shows a newer head", async () => {
    github.getPullRequestStack.mockResolvedValue({ entries: [{ number: 1, headSha: "newer" }] });
    expect(await prepareMerge(repo, pr)).toBeNull();
  });
});
