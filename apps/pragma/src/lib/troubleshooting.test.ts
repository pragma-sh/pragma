import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "@pragma/constants";

const restartDaemon = vi.fn(() => Promise.resolve());
vi.mock("@/lib/tauri", () => ({ restartDaemon: () => restartDaemon() }));

const { restartServer } = await import("@/lib/troubleshooting");

function tab(id: string): Tab {
  return { id } as unknown as Tab;
}

describe("restartServer", () => {
  beforeEach(() => {
    restartDaemon.mockClear();
  });

  it("closes every tab before restarting, since the restart kills their sessions", async () => {
    const closed: string[] = [];
    const closeTab = vi.fn((tabId: string) => {
      closed.push(tabId);
      return Promise.resolve();
    });

    await restartServer({ tabs: [tab("a"), tab("b")], closeTab });

    expect(closed).toEqual(["a", "b"]);
    expect(restartDaemon).toHaveBeenCalledOnce();
    expect(closeTab.mock.invocationCallOrder[0]).toBeLessThan(
      restartDaemon.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("restarts with no tabs open", async () => {
    await restartServer({ tabs: [], closeTab: vi.fn(() => Promise.resolve()) });

    expect(restartDaemon).toHaveBeenCalledOnce();
  });
});
