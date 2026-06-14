import type { Tab } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserView } from "./BrowserView";
import { TabDragProvider, useTabDrag } from "@/components/tabs/tab-drag-context";

// The browser commands are native; mock the typed bridge so we can assert the
// visibility/bounds calls the component makes as drag state changes.
const tauriMocks = vi.hoisted(() => ({
  browserCreate: vi.fn(() => Promise.resolve()),
  browserSetVisible: vi.fn(() => Promise.resolve()),
  browserSetBounds: vi.fn(() => Promise.resolve()),
  browserFrameHeight: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("@/lib/tauri", () => ({
  browserBack: vi.fn(() => Promise.resolve()),
  browserClearData: vi.fn(() => Promise.resolve()),
  browserCreate: tauriMocks.browserCreate,
  browserDevtools: vi.fn(() => Promise.resolve()),
  browserForward: vi.fn(() => Promise.resolve()),
  browserFrameHeight: tauriMocks.browserFrameHeight,
  browserNavigate: vi.fn(() => Promise.resolve()),
  browserOpenExternal: vi.fn(() => Promise.resolve()),
  browserReload: vi.fn(() => Promise.resolve()),
  browserScreenshot: vi.fn(() => Promise.resolve(null)),
  browserSetBounds: tauriMocks.browserSetBounds,
  browserSetVisible: tauriMocks.browserSetVisible,
}));

function browserTab(): Tab {
  return {
    id: "browser-1",
    projectId: "project",
    worktreeId: "worktree",
    kind: "browser",
    title: "Browser",
    url: "https://example.com",
    orderIndex: 0,
    createdAt: "now",
  };
}

/** Starts a tab drag from inside the provider so `isDragging` flips on. */
function DragTrigger() {
  const { beginTabDrag } = useTabDrag();
  return <button onClick={() => beginTabDrag("some-other-tab")}>start drag</button>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BrowserView", () => {
  it("collapses and hides the native webview while a tab drag is in flight", async () => {
    render(
      <TabDragProvider>
        <DragTrigger />
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );

    // Mounts visible (the active tab's page is shown).
    await waitFor(() =>
      expect(tauriMocks.browserSetVisible).toHaveBeenCalledWith("browser-1", true),
    );
    tauriMocks.browserSetVisible.mockClear();
    tauriMocks.browserSetBounds.mockClear();

    await userEvent.click(screen.getByText("start drag"));

    // While dragging, the overlay would otherwise float above and swallow drops,
    // so the webview is hidden AND collapsed to zero size to free the whole pane.
    await waitFor(() =>
      expect(tauriMocks.browserSetVisible).toHaveBeenCalledWith("browser-1", false),
    );
    expect(tauriMocks.browserSetBounds).toHaveBeenCalledWith("browser-1", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
