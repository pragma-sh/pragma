import { describe, expect, it } from "vitest";

import { portsForWorktree } from "./ports";

describe("portsForWorktree", () => {
  it("filters and orders detected listeners", () => {
    const ports = [
      { port: 5174, process: "node", pid: 2, tabId: "b", worktreeId: "wanted" },
      { port: 3000, process: "next", pid: 3, tabId: "c", worktreeId: "other" },
      { port: 5173, process: "vite", pid: 1, tabId: "a", worktreeId: "wanted" },
    ];

    expect(portsForWorktree(ports, "wanted").map((port) => port.port)).toEqual([5173, 5174]);
  });
});
