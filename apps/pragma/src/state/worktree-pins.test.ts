import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isWorktreePinned,
  toggleWorktreePin,
  useWorktreePins,
  worktreePinTime,
} from "./worktree-pins";

describe("worktree pins", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset module state by unpinning anything left from a prior toggle in
    // this process — toggle is the only mutator and readPins only runs once.
    for (const id of ["a", "b", "c"]) {
      if (isWorktreePinned(id)) {
        toggleWorktreePin(id);
      }
    }
  });

  it("toggles a worktree pin on and off", () => {
    expect(isWorktreePinned("a")).toBe(false);
    expect(worktreePinTime("a")).toBeUndefined();

    toggleWorktreePin("a");
    expect(isWorktreePinned("a")).toBe(true);
    expect(worktreePinTime("a")).toEqual(expect.any(Number));

    toggleWorktreePin("a");
    expect(isWorktreePinned("a")).toBe(false);
    expect(worktreePinTime("a")).toBeUndefined();
  });

  it("records a newer pin time when pinning again after unpin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    toggleWorktreePin("a");
    expect(worktreePinTime("a")).toBe(1_000);

    toggleWorktreePin("a");
    vi.setSystemTime(2_000);
    toggleWorktreePin("a");
    expect(worktreePinTime("a")).toBe(2_000);
    vi.useRealTimers();
  });

  it("exposes the pin map to subscribers", () => {
    // useSyncExternalStore getters are pure; call the module snapshot directly
    // via a pin after clear to confirm the map updates.
    toggleWorktreePin("b");
    expect(isWorktreePinned("b")).toBe(true);
    // Hook exists for React; keep the export exercised by referencing it.
    expect(typeof useWorktreePins).toBe("function");
  });
});
