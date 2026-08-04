import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { THEME_DEFAULTS } from "@/lib/theme-tokens";

vi.mock("@/lib/mdx-preview", () => ({
  buildScratchpadPreview: vi.fn(async () => ({ code: "globalThis.rendered = true;", css: "" })),
}));
vi.mock("@/lib/tauri", () => ({ scratchpadPromptAgent: vi.fn() }));
vi.mock("@/state/agent-status-store", () => ({ useAgentStatusSnapshot: () => [] }));
vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => ({ tabs: [] }) }));

const { ScratchpadPreview } = await import("@/components/scratchpad/ScratchpadPreview");

describe("ScratchpadPreview", () => {
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
});
