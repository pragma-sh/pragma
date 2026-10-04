import type { Whiteboard, WhiteboardsClient } from "@pragma-sh/sdk";
import { describe, expect, it, vi } from "vitest";

import { getWhiteboardSnapshot } from "./whiteboard-snapshot";

const board: Whiteboard = {
  id: "board-1",
  worktreeId: "worktree-1",
  title: "System map",
  scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} },
  version: 4,
  createdAt: 1,
  updatedAt: 2,
};

function client(value: Whiteboard = board): Pick<WhiteboardsClient, "get" | "view"> {
  return {
    get: vi.fn(async () => value),
    view: vi.fn(async () => new Uint8Array([112, 110, 103])),
  };
}

describe("getWhiteboardSnapshot", () => {
  it("returns a PNG data URL when the version changed", async () => {
    const whiteboards = client();
    await expect(getWhiteboardSnapshot(whiteboards, "worktree-1", "board-1", 3)).resolves.toEqual({
      id: "board-1",
      title: "System map",
      version: 4,
      dataUrl: "data:image/png;base64,cG5n",
    });
    expect(whiteboards.get).toHaveBeenCalledWith({ worktreeId: "worktree-1", id: "board-1" });
    expect(whiteboards.view).toHaveBeenCalledWith({
      worktreeId: "worktree-1",
      id: "board-1",
      dark: false,
    });
  });

  it("skips rendering when the caller already has the current version", async () => {
    const whiteboards = client();

    await expect(
      getWhiteboardSnapshot(whiteboards, "worktree-1", "board-1", 4),
    ).resolves.toBeNull();
    expect(whiteboards.view).not.toHaveBeenCalled();
  });

  it("rejects a whiteboard from another worktree before rendering", async () => {
    const whiteboards = client();

    await expect(getWhiteboardSnapshot(whiteboards, "worktree-2", "board-1")).rejects.toThrow(
      "Whiteboard belongs to another worktree",
    );
    expect(whiteboards.view).not.toHaveBeenCalled();
  });
});
