import { describe, expect, it, vi } from "vitest";

const listDirEntriesMock = vi.fn();

const listRecentIssuesMock = vi.fn();
const getIssueDetailMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listDirEntries: (...args: unknown[]) => listDirEntriesMock(...args),
  paletteSearch: vi.fn(),
  cancelPaletteSearch: vi.fn(),
  githubRepoRef: async () => ({ owner: "o", repo: "r", headBranch: "main" }),
}));

vi.mock("@/lib/github", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/github")>()),
  listRecentIssues: (...args: unknown[]) => listRecentIssuesMock(...args),
  getIssueDetail: (...args: unknown[]) => getIssueDetailMock(...args),
}));

import { isContextProviderNotice } from "@pragma-sh/plugin/catalog";

import { GitHubAuthError } from "@/lib/github";

import { BUILTIN_CONTEXT_PROVIDERS, formatIssueContext } from "./builtin-context-providers";

const searchInput = {
  query: "",
  project: { id: "p", name: "Repo", path: "/repo" },
  worktree: { id: "wt", path: "/repo", branch: "main" },
  signal: new AbortController().signal,
};

describe("built-in providers", () => {
  it("lists issues and pull requests above files", () => {
    expect(BUILTIN_CONTEXT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "github-issues",
      "github-pulls",
      "files",
    ]);
  });

  it("offers recent issues for a bare @", async () => {
    listRecentIssuesMock.mockResolvedValue([
      { number: 7, title: "Crash", kind: "issue", state: "open" },
      { number: 8, title: "Fix crash", kind: "pull", state: "open" },
    ]);
    const issues = BUILTIN_CONTEXT_PROVIDERS[0]!;
    const items = await issues.search(searchInput, {} as never);
    expect(items.map((item) => item.displayName)).toEqual(["#7"]);
  });

  it("reaches an older open issue by number but never offers a closed one", async () => {
    listRecentIssuesMock.mockResolvedValue([]);
    const issues = BUILTIN_CONTEXT_PROVIDERS[0]!;
    const detail = { title: "Old", kind: "issue", body: "", htmlUrl: "u", author: null };
    getIssueDetailMock.mockResolvedValueOnce({ ...detail, number: 3, state: "open" });
    const open = await issues.search({ ...searchInput, query: "#3" }, {} as never);
    expect(open.map((item) => item.displayName)).toEqual(["#3"]);

    getIssueDetailMock.mockResolvedValueOnce({ ...detail, number: 2, state: "closed" });
    const closed = await issues.search({ ...searchInput, query: "2" }, {} as never);
    expect(closed).toEqual([]);
  });

  it("asks the user to sign in instead of showing nothing when signed out", async () => {
    listRecentIssuesMock.mockRejectedValue(new GitHubAuthError());
    const pulls = BUILTIN_CONTEXT_PROVIDERS[1]!;
    const cause = await Promise.resolve(pulls.search(searchInput, {} as never)).catch(
      (error: unknown) => error,
    );
    expect(isContextProviderNotice(cause)).toBe(true);
    expect((cause as Error).message).toMatch(/Sign in to GitHub/);
  });
});

describe("files provider", () => {
  const files = BUILTIN_CONTEXT_PROVIDERS.find((provider) => provider.id === "files")!;
  const input = {
    query: "",
    project: { id: "p", name: "Repo", path: "/repo" },
    worktree: { id: "wt", path: "/repo", branch: "main" },
    signal: new AbortController().signal,
  };

  it("lists the worktree root for a bare @: folders first, dotfiles skipped", async () => {
    listDirEntriesMock.mockResolvedValue([
      { name: "README.md", path: "README.md", isDir: false },
      { name: ".github", path: ".github", isDir: true },
      { name: "src", path: "src", isDir: true },
      { name: "package.json", path: "package.json", isDir: false },
    ]);
    const items = await files.search(input, {} as never);
    expect(listDirEntriesMock).toHaveBeenCalledWith("wt", "");
    expect(items.map((item) => item.displayName)).toEqual(["src/", "package.json", "README.md"]);
  });

  it("tells the agent whether a mention is a folder or a file", async () => {
    const folder = await files.resolve(
      { ...input, item: { id: "src", displayName: "src/", data: { isDir: true } } },
      {} as never,
    );
    const file = await files.resolve(
      { ...input, item: { id: "a.ts", displayName: "a.ts", data: { isDir: false } } },
      {} as never,
    );
    expect(folder).toContain("folder `src/`");
    expect(file).toContain("file `a.ts`");
  });
});

describe("formatIssueContext", () => {
  it("carries the body and a link for further detail", () => {
    const text = formatIssueContext({
      number: 42,
      title: "Crash on launch",
      kind: "pull",
      state: "open",
      body: "Steps to reproduce\n",
      htmlUrl: "https://github.com/o/r/pull/42",
      author: "octo",
    });
    expect(text).toContain("GitHub pull request #42: Crash on launch (open)");
    expect(text).toContain("Link: https://github.com/o/r/pull/42");
    expect(text).toContain("gh pr view 42 --comments");
    expect(text.endsWith("Steps to reproduce")).toBe(true);
  });

  it("marks an empty body", () => {
    const text = formatIssueContext({
      number: 7,
      title: "Idea",
      kind: "issue",
      state: "closed",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/7",
      author: null,
    });
    expect(text).not.toContain("Author:");
    expect(text).toContain("gh issue view 7");
    expect(text.endsWith("(no description)")).toBe(true);
  });
});
