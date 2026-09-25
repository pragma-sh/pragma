import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorktreeStorage } from "@pragma-sh/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelWorktreeStorageScan,
  deleteIgnoredFolder,
  listProjects,
  listWorktrees,
  scanWorktreeStorage,
} from "@/lib/tauri";

import { StorageSection } from "./StorageSection";

vi.mock("@/lib/tauri", () => ({
  cancelWorktreeStorageScan: vi.fn(),
  deleteIgnoredFolder: vi.fn(),
  listProjects: vi.fn(),
  listWorktrees: vi.fn(),
  scanWorktreeStorage: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const MB = 1024 * 1024;

function scanResult(folders: { path: string; mb: number }[]): WorktreeStorage {
  const ignored = folders.reduce((sum, folder) => sum + folder.mb * MB, 0);
  return {
    totalBytes: ignored + 10 * MB,
    fileCount: 10,
    gitBytes: MB,
    ignoredBytes: ignored,
    largeFiles: [],
    ignoredFolders: folders.map((folder) => ({
      path: folder.path,
      bytes: folder.mb * MB,
      fileCount: 3,
    })),
    truncated: false,
    tree: folders.map((folder) => ({
      name: folder.path,
      bytes: folder.mb * MB,
      fileCount: 3,
      kind: "folder" as const,
      children: [],
    })),
  };
}

function renderSection(scope: "global" | "project" = "global") {
  return render(
    <StorageSection
      persistReminder={vi.fn()}
      projectId="p1"
      projectName="Pragma"
      reminder={scope === "global" ? {} : null}
      scope={scope}
    />,
  );
}

describe("StorageSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "p1", name: "Pragma", path: "/p1", iconEmoji: null, orderIndex: 0, createdAt: "" },
      { id: "p2", name: "Other", path: "/p2", iconEmoji: null, orderIndex: 1, createdAt: "" },
    ]);
    vi.mocked(listWorktrees).mockImplementation(async (projectId) => [
      {
        id: `${projectId}-main`,
        projectId,
        parentId: null,
        branch: "main",
        title: null,
        path: `/${projectId}`,
        isMain: true,
        hidden: false,
        createdAt: "",
      } as Awaited<ReturnType<typeof listWorktrees>>[number],
    ]);
    vi.mocked(scanWorktreeStorage).mockImplementation(async (worktreeId) =>
      worktreeId === "p1-main"
        ? scanResult([{ path: "node_modules", mb: 200 }])
        : scanResult([{ path: "target", mb: 500 }]),
    );
    vi.mocked(deleteIgnoredFolder).mockResolvedValue();
    vi.mocked(cancelWorktreeStorageScan).mockResolvedValue();
  });

  it("totals every project in global scope", async () => {
    renderSection();
    expect(await screen.findByText("720 MB")).toBeInTheDocument();
    expect(screen.getByText(/2 projects · 2 worktrees · 700 MB reclaimable/)).toBeInTheDocument();
    expect(screen.getByText("Storage reminder")).toBeInTheDocument();
  });

  it("scans only the current project's worktrees in project scope", async () => {
    renderSection("project");
    // The summary and the lone worktree's row both show the one total.
    expect(await screen.findAllByText("210 MB")).toHaveLength(2);
    expect(scanWorktreeStorage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^1 worktree/)).toBeInTheDocument();
    expect(screen.queryByText("Storage reminder")).not.toBeInTheDocument();
  });

  it("deletes one folder after confirmation and updates the totals", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete node_modules" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteIgnoredFolder).toHaveBeenCalledWith("p1-main", "node_modules"),
    );
    expect(await screen.findByText("520 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete node_modules" })).not.toBeInTheDocument();
  });

  it("deletes every folder at once", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /Delete all/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 2 folders?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteIgnoredFolder).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No large gitignored folders found yet.")).toBeInTheDocument();
  });

  it("cancels in-flight scans when the page closes", async () => {
    vi.mocked(scanWorktreeStorage).mockImplementation(() => new Promise(() => undefined));
    const { unmount } = renderSection();
    await waitFor(() => expect(scanWorktreeStorage).toHaveBeenCalledTimes(2));
    unmount();
    expect(cancelWorktreeStorageScan).toHaveBeenCalledTimes(2);
  });
});
