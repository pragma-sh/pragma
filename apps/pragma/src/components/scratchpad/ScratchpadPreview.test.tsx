import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_DEFAULTS } from "@/lib/theme-tokens";

const mocks = vi.hoisted(() => ({
  getWhiteboard: vi.fn(),
  openWhiteboard: vi.fn(),
}));

vi.mock("@/lib/mdx-preview", () => ({
  buildScratchpadPreview: vi.fn(async () => ({ code: "globalThis.rendered = true;", css: "" })),
}));
vi.mock("@/lib/tauri", () => ({
  getWhiteboard: mocks.getWhiteboard,
  scratchpadPromptAgent: vi.fn(),
  viewWhiteboard: vi.fn(),
}));
vi.mock("@/state/agent-status-store", () => ({ useAgentStatusSnapshot: () => [] }));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ openWhiteboard: mocks.openWhiteboard, tabs: [] }),
}));

const { ScratchpadPreview } = await import("@/components/scratchpad/ScratchpadPreview");

describe("ScratchpadPreview", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mocks.getWhiteboard.mockReset();
    mocks.openWhiteboard.mockReset();
  });

  it("persists only messages from the matching sandbox and restores its state", async () => {
    const props = {
      filePath: ".pragma/scratchpads/example.mdx",
      getAttachedAgentTabId: () => null,
      onRequestAgentAttachment: async () => false,
      source: "<Example />",
      worktreeId: "worktree-1",
      blockKey: "block-1",
    };
    const view = render(<ScratchpadPreview {...props} />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    const token = JSON.parse(frame.srcdoc.match(/const token = ("[^"]+");/)![1]!) as string;
    const message = {
      channel: "pragma-scratchpad",
      token,
      type: "local-state",
      state: { answer: "hello" },
    };
    window.dispatchEvent(new MessageEvent("message", { source: window, data: message }));
    expect(localStorage.length).toBe(0);
    window.dispatchEvent(
      new MessageEvent("message", { source: frame.contentWindow, data: message }),
    );
    expect(localStorage.length).toBe(1);
    view.unmount();
    render(<ScratchpadPreview {...props} />);
    const restored = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    expect(restored.srcdoc).toContain('\\"answer\\":\\"hello\\"');
  });

  it("warns without blocking when saved state cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(
      <ScratchpadPreview
        filePath=".pragma/scratchpads/example.mdx"
        getAttachedAgentTabId={() => null}
        onRequestAgentAttachment={async () => false}
        source="<button>Example</button>"
        worktreeId="worktree-1"
      />,
    );

    expect(await screen.findByText(/Saved answers could not be loaded/)).toBeInTheDocument();
    expect(screen.getByTitle("Rendered MDX component")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("warns without blocking when a frame save fails", async () => {
    const props = {
      filePath: ".pragma/scratchpads/example.mdx",
      getAttachedAgentTabId: () => null,
      onRequestAgentAttachment: async () => false,
      source: "<Example />",
      worktreeId: "worktree-1",
      blockKey: "block-1",
    };
    render(<ScratchpadPreview {...props} />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    const token = JSON.parse(frame.srcdoc.match(/const token = ("[^"]+");/)![1]!) as string;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel: "pragma-scratchpad", token, type: "local-state", state: { a: "b" } },
      }),
    );

    expect(await screen.findByText(/Answers could not be saved \(quota exceeded\)/)).toBeVisible();
    vi.restoreAllMocks();
  });

  it("boots Vite modules inside an opaque sandbox", async () => {
    render(
      <ScratchpadPreview
        filePath=".pragma/scratchpads/example.mdx"
        getAttachedAgentTabId={() => null}
        onRequestAgentAttachment={async () => false}
        source="<button>Example</button>"
        worktreeId="worktree-1"
      />,
    );

    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.srcdoc).toContain("globalThis.$RefreshReg$ = () => {};");
    expect(frame.srcdoc).toContain("globalThis.$RefreshSig$ = () => (type) => type;");
    expect(frame.srcdoc).toContain('openWhiteboard: (whiteboardId) => request("openWhiteboard"');
  });

  it("adopts the desktop theme variables instead of restating colors", async () => {
    document.documentElement.classList.add("dark");
    render(
      <ScratchpadPreview
        filePath=".pragma/scratchpads/example.mdx"
        getAttachedAgentTabId={() => null}
        onRequestAgentAttachment={async () => false}
        source="<button>Example</button>"
        worktreeId="worktree-1"
      />,
    );

    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    expect(frame.srcdoc).toContain('<style id="pragma-scratchpad-theme">');
    expect(frame.srcdoc).toContain(`--card:${THEME_DEFAULTS.dark.card}`);
    expect(frame.srcdoc).toContain("color-scheme:dark");
  });

  it("opens an embedded whiteboard in the interactive desktop tab", async () => {
    mocks.getWhiteboard.mockResolvedValue({
      id: "board-1",
      worktreeId: "worktree-1",
      title: "System map",
    });
    render(
      <ScratchpadPreview
        filePath=".pragma/scratchpads/example.mdx"
        getAttachedAgentTabId={() => null}
        onRequestAgentAttachment={async () => false}
        source='<Whiteboard id="board-1" />'
        worktreeId="worktree-1"
      />,
    );

    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered MDX component");
    const tokenLiteral = frame.srcdoc.match(/const token = ("[^"]+");/)?.[1];
    if (!tokenLiteral) throw new Error("frame token missing");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel: "pragma-scratchpad",
          token: JSON.parse(tokenLiteral) as string,
          type: "request",
          id: "request-1",
          method: "openWhiteboard",
          whiteboardId: "board-1",
        },
      }),
    );

    await waitFor(() => expect(mocks.openWhiteboard).toHaveBeenCalledWith("board-1", "System map"));
  });
});
