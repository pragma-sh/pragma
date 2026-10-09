import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
const create = vi.fn();

vi.mock("./index", () => ({
  createGitHubClient: () => ({ rest: { pulls: { list, create } } }),
}));

const { findPullRequest, publishPullRequest } = await import("./pull-requests");

const target = { owner: "pragma-sh", repo: "pragma", head: "feature" };

function apiPullRequest(over: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Fix session reconnect",
    html_url: "https://github.com/pragma-sh/pragma/pull/12",
    state: "open",
    draft: false,
    merged_at: null,
    created_at: "2026-09-01T00:00:00Z",
    head: { ref: "feature" },
    base: { ref: "main" },
    ...over,
  };
}

describe("findPullRequest", () => {
  it("matches on repository plus exact head branch, in any state", async () => {
    list.mockResolvedValueOnce({ data: [apiPullRequest()] });

    const found = await findPullRequest("token", target);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ head: "pragma-sh:feature", state: "all" }),
    );
    expect(found).toEqual({
      number: 12,
      title: "Fix session reconnect",
      url: "https://github.com/pragma-sh/pragma/pull/12",
      state: "open",
      headBranch: "feature",
      baseBranch: "main",
    });
  });

  it("returns the newest when a reused branch has several", async () => {
    list.mockResolvedValueOnce({
      data: [
        apiPullRequest({ number: 3, created_at: "2026-01-01T00:00:00Z", merged_at: "x" }),
        apiPullRequest({ number: 9, created_at: "2026-09-01T00:00:00Z" }),
      ],
    });

    expect((await findPullRequest("token", target))?.number).toBe(9);
  });

  it("reports merged and closed distinctly, and draft as its own state", async () => {
    list.mockResolvedValueOnce({ data: [apiPullRequest({ merged_at: "2026-09-02T00:00:00Z" })] });
    expect((await findPullRequest("token", target))?.state).toBe("merged");

    list.mockResolvedValueOnce({ data: [apiPullRequest({ state: "closed" })] });
    expect((await findPullRequest("token", target))?.state).toBe("closed");

    list.mockResolvedValueOnce({ data: [apiPullRequest({ draft: true })] });
    expect((await findPullRequest("token", target))?.state).toBe("draft");
  });

  it("does not re-qualify a fork head that already names its owner", async () => {
    list.mockResolvedValueOnce({ data: [] });

    await findPullRequest("token", { ...target, head: "someone-else:feature" });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ head: "someone-else:feature" }));
  });

  it("returns null when the branch has no pull request", async () => {
    list.mockResolvedValueOnce({ data: [] });

    expect(await findPullRequest("token", target)).toBeNull();
  });
});

describe("publishPullRequest", () => {
  const input = { ...target, title: "T", body: "B", base: "main", draft: false };

  it("creates the pull request", async () => {
    create.mockResolvedValueOnce({ data: apiPullRequest() });

    expect((await publishPullRequest("token", input)).number).toBe(12);
  });

  it("treats an existing pull request as the result, not a failure", async () => {
    // GitHub answers a duplicate create with a 422. The request the caller
    // wanted is already there; reporting an error invites them to retry into
    // the same wall.
    create.mockRejectedValueOnce({
      status: 422,
      response: { data: { errors: [{ message: "A pull request already exists for x:feature." }] } },
    });
    list.mockResolvedValueOnce({ data: [apiPullRequest({ number: 44 })] });

    expect((await publishPullRequest("token", input)).number).toBe(44);
  });

  it("rethrows a failure that is not a duplicate", async () => {
    create.mockRejectedValueOnce({ status: 403, response: { data: {} } });

    await expect(publishPullRequest("token", input)).rejects.toMatchObject({ status: 403 });
  });
});
