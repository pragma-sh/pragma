import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentReportPayload } from "@pragma/constants";

const workspace = vi.hoisted(() => ({
  projects: [
    { id: "project-1", name: "Alpha" },
    { id: "project-2", name: "Beta" },
  ],
  icons: {
    "project-1": { mime: "image/svg+xml", dataBase64: "PHN2Zy8+" },
  } as Record<string, { mime: string; dataBase64: string } | null>,
  selectedProjectId: "project-1",
  selectProject: vi.fn(),
  reload: vi.fn(),
  worktrees: {
    "project-1": [{ id: "worktree-1" }],
    "project-2": [{ id: "worktree-2" }],
  },
}));

const removeProject = vi.hoisted(() => vi.fn());

vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => workspace }));
vi.mock("@/lib/tauri", () => ({ removeProject }));

import { ProjectSwitcher } from "./ProjectSwitcher";
import { applyAgentReport, clearAllAgentStatuses } from "@/state/agent-status-store";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearAllAgentStatuses();
});

describe("ProjectSwitcher", () => {
  it("keeps wheel and swipe gestures over the strip from reaching the sidebar", () => {
    const onWheel = vi.fn();
    const onTouchStart = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- mirrors the sidebar's gesture handlers under test
      <div onTouchStart={onTouchStart} onWheel={onWheel}>
        <ProjectSwitcher />
      </div>,
    );

    const strip = screen.getByLabelText("Project switcher");
    fireEvent.wheel(strip, { deltaX: 120 });
    fireEvent.touchStart(strip, { touches: [{ clientX: 10 }] });

    expect(onWheel).not.toHaveBeenCalled();
    expect(onTouchStart).not.toHaveBeenCalled();
  });

  it("paints project icons in the button's own foreground colour", () => {
    render(<ProjectSwitcher />);

    const glyph = screen.getByRole("button", { name: "Alpha" }).firstElementChild;

    // A mask in `currentColor` — not a brightness filter — is what keeps the
    // glyph legible in both the selected and unselected states.
    expect(glyph?.className).toContain("bg-current");
  });

  it("marks the selected project for assistive tech", () => {
    render(<ProjectSwitcher />);

    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows aggregate agent status on each project icon", () => {
    applyAgentReport({
      worktreeId: "worktree-1",
      tabId: "tab-1",
      agent: "opencode",
      status: "running",
    } as AgentReportPayload);
    applyAgentReport({
      worktreeId: "worktree-1",
      tabId: "tab-2",
      agent: "claude-code",
      status: "attention",
    } as AgentReportPayload);

    render(<ProjectSwitcher />);

    expect(screen.getByTitle("Agent attention")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Beta" }).querySelector("[title^='Agent']"),
    ).toBeNull();
  });

  it("removes a project from its context menu", async () => {
    render(<ProjectSwitcher />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    fireEvent.click(await screen.findByText("Remove project"));

    expect(removeProject).toHaveBeenCalledWith("project-2");
    await waitFor(() => expect(workspace.reload).toHaveBeenCalled());
  });
});
