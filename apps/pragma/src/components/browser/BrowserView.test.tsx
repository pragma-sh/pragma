import type { Tab } from "@pragma/constants";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  browserNavigate: vi.fn(() => Promise.resolve()),
  onBrowserLoad: vi.fn(
    (
      _handler: (load: {
        tabId: string;
        status: "started" | "finished" | "failed";
        url: string;
      }) => void,
    ) => Promise.resolve(() => {}),
  ),
  browserSnapshot: vi.fn(() => Promise.resolve("data:image/png;base64,STILL")),
  browserDesignSet: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  browserBack: vi.fn(() => Promise.resolve()),
  browserClearData: vi.fn(() => Promise.resolve()),
  browserCreate: tauriMocks.browserCreate,
  browserDevtools: vi.fn(() => Promise.resolve()),
  browserForward: vi.fn(() => Promise.resolve()),
  browserFrameHeight: tauriMocks.browserFrameHeight,
  browserNavigate: tauriMocks.browserNavigate,
  browserOpenExternal: vi.fn(() => Promise.resolve()),
  browserReload: vi.fn(() => Promise.resolve()),
  browserScreenshot: vi.fn(() => Promise.resolve(null)),
  browserSetBounds: tauriMocks.browserSetBounds,
  browserSetVisible: tauriMocks.browserSetVisible,
  browserSnapshot: tauriMocks.browserSnapshot,
  onBrowserLoad: tauriMocks.onBrowserLoad,
  browserFindSet: vi.fn(() => Promise.resolve({ count: 0, index: -1 })),
  browserFindSeek: vi.fn(() => Promise.resolve({ count: 0, index: -1 })),
  browserFindClear: vi.fn(() => Promise.resolve()),
  onBrowserFindRequest: vi.fn(() => Promise.resolve(() => {})),
  browserDesignSet: tauriMocks.browserDesignSet,
  onBrowserDesignStage: vi.fn(() => Promise.resolve(() => {})),
}));

function browserTab(url = "https://example.com"): Tab {
  return {
    id: "browser-1",
    projectId: "project",
    worktreeId: "worktree",
    kind: "browser",
    title: "Browser",
    url,
    filePath: null,
    diffSide: null,
    diffCommit: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    agentId: null,
    userRenamed: false,
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
  it("navigates to a typed address when Enter is pressed", async () => {
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );

    const address = screen.getByLabelText("Address");
    await userEvent.clear(address);
    await userEvent.type(address, "  example.org/docs  {Enter}");

    expect(tauriMocks.browserNavigate).toHaveBeenCalledOnce();
    expect(tauriMocks.browserNavigate).toHaveBeenCalledWith("browser-1", "example.org/docs");
  });

  it("shows recovery UI when navigation fails and retries the address", async () => {
    tauriMocks.browserNavigate.mockRejectedValueOnce(new Error("navigation failed"));
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );

    const address = screen.getByLabelText("Address");
    await userEvent.clear(address);
    await userEvent.type(address, "missing.localhost:5173{Enter}");

    expect(await screen.findByText("This page couldn't be reached")).toBeInTheDocument();
    expect(screen.getByText("missing.localhost:5173")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(tauriMocks.browserNavigate).toHaveBeenCalledTimes(2);
    expect(tauriMocks.browserNavigate).toHaveBeenLastCalledWith(
      "browser-1",
      "missing.localhost:5173",
    );
    await waitFor(() =>
      expect(screen.queryByText("This page couldn't be reached")).not.toBeInTheDocument(),
    );
  });

  it("shows recovery UI when the native webview reports a blank failed page", async () => {
    let handleLoad:
      | ((load: { tabId: string; status: "started" | "finished" | "failed"; url: string }) => void)
      | undefined;
    tauriMocks.onBrowserLoad.mockImplementationOnce((handler) => {
      handleLoad = handler;
      return Promise.resolve(() => {});
    });
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );
    await waitFor(() => expect(handleLoad).toBeDefined());

    act(() => {
      handleLoad?.({
        tabId: "browser-1",
        status: "started",
        url: "https://does-not-exist.invalid/",
      });
      handleLoad?.({
        tabId: "browser-1",
        status: "finished",
        url: "https://does-not-exist.invalid/",
      });
      handleLoad?.({
        tabId: "browser-1",
        status: "failed",
        url: "https://does-not-exist.invalid/",
      });
    });

    expect(screen.getByText("This page couldn't be reached")).toBeInTheDocument();
    expect(screen.getByText("https://does-not-exist.invalid/")).toBeInTheDocument();
  });

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

  it("snapshots then hides the native webview while a toolbar dropdown is open", async () => {
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );

    await waitFor(() =>
      expect(tauriMocks.browserSetVisible).toHaveBeenCalledWith("browser-1", true),
    );
    tauriMocks.browserSetVisible.mockClear();

    // Opening the "More options" menu must step the native overlay aside (it
    // paints above all HTML and would otherwise clip the dropdown), but first
    // capture a still of the page and paint it so the pane looks unchanged.
    await userEvent.click(screen.getByLabelText("More options"));
    await waitFor(() => expect(tauriMocks.browserSnapshot).toHaveBeenCalled());
    await waitFor(() =>
      expect(tauriMocks.browserSetVisible).toHaveBeenCalledWith("browser-1", false),
    );
    await waitFor(() =>
      expect(document.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,STILL"),
    );

    // Closing it restores the live page and drops the still.
    tauriMocks.browserSetVisible.mockClear();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(tauriMocks.browserSetVisible).toHaveBeenCalledWith("browser-1", true),
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("toggles design mode from the toolbar on a local dev server", async () => {
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab("http://localhost:5173/pricing")} />
      </TabDragProvider>,
    );

    const toggle = screen.getByLabelText("Design mode");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);

    expect(tauriMocks.browserDesignSet).toHaveBeenCalledWith(
      "browser-1",
      true,
      expect.objectContaining({ primary: expect.any(String) }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(toggle);

    expect(tauriMocks.browserDesignSet).toHaveBeenCalledWith(
      "browser-1",
      false,
      expect.objectContaining({ primary: expect.any(String) }),
    );
  });

  it("hides the design-mode toggle in the overflow menu for remote pages", async () => {
    render(
      <TabDragProvider>
        <BrowserView active tab={browserTab()} />
      </TabDragProvider>,
    );

    expect(screen.queryByLabelText("Design mode")).toBeNull();

    await userEvent.click(screen.getByLabelText("More options"));

    expect(await screen.findByText("Design mode")).toBeInTheDocument();
  });
});
