import type { Worktree } from "@pragma/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const githubFetchAndSyncMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  githubFetchAndSync: (...args: unknown[]) => githubFetchAndSyncMock(...args),
}));

import { mainBehindRemote } from "./worktree-sync";

const main: Worktree = {
  id: "main",
  projectId: "project",
  parentId: null,
  branch: "main",
  title: null,
  path: "/repo",
  isMain: true,
  hidden: false,
  createdAt: "2026-08-27",
};

describe("mainBehindRemote", () => {
  beforeEach(() => {
    githubFetchAndSyncMock.mockReset();
  });

  it("returns main when its remote has newer commits", async () => {
    githubFetchAndSyncMock.mockResolvedValue({ behind: 2 });

    await expect(mainBehindRemote([main])).resolves.toEqual({ id: "main", behind: 2 });
    expect(githubFetchAndSyncMock).toHaveBeenCalledWith("main");
  });

  it("allows creation when sync status cannot be fetched", async () => {
    githubFetchAndSyncMock.mockRejectedValue(new Error("offline"));

    await expect(mainBehindRemote([main])).resolves.toBeNull();
  });

  it("rejects projects without a main worktree", async () => {
    await expect(mainBehindRemote([])).rejects.toThrow("Project main worktree was not found");
  });
});
