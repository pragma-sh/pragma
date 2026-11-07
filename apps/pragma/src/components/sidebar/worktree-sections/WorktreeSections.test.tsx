import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "@pragma-sh/constants";
import type { PluginDefinition, PluginWorktree } from "@pragma-sh/plugin";
import type { PragmaClient } from "@pragma-sh/sdk";

const mocks = vi.hoisted(() => ({
  activateTabLocation: vi.fn(),
  exitBoard: vi.fn(),
  listScratchpads: vi.fn(),
  listWhiteboards: vi.fn(),
  openScratchpadFile: vi.fn(),
  openWhiteboard: vi.fn(),
  openPorts: [] as unknown[],
  projectTabs: [] as unknown[],
  compact: false,
}));

vi.mock("@/lib/tauri", () => ({
  deleteWhiteboard: vi.fn(),
  listScratchpads: mocks.listScratchpads,
  listWhiteboards: mocks.listWhiteboards,
}));
vi.mock("@/lib/file-watch", () => ({ subscribeToWorktreeFiles: () => () => undefined }));
vi.mock("@/state/kanban-context", () => ({ useKanban: () => ({ exitBoard: mocks.exitBoard }) }));
vi.mock("@/state/open-ports-context", () => ({ useOpenPorts: () => mocks.openPorts }));
vi.mock("@/state/sidebar-preferences", () => ({ useCompactWorktreeRows: () => mocks.compact }));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    activateTabLocation: mocks.activateTabLocation,
    closeTab: vi.fn(),
    openScratchpadFile: mocks.openScratchpadFile,
    openWhiteboard: mocks.openWhiteboard,
    projectTabs: mocks.projectTabs,
    selectedProjectId: "project",
    worktrees: {},
  }),
}));

import { hostHooks, setPluginRuntimeSdk } from "@/plugins/host-hooks";
import { clearPlugins, setPluginsForScope } from "@/plugins/registry";
import { useWorktreeRowSections } from "./WorktreeSections";

let nextId = 0;

/** A plugin section body that reads its row through `useWorktree()`. */
function Body() {
  return <p>Body for {hostHooks.useWorktree().branch}</p>;
}

/** A fresh worktree per test: the list caches and expanded state are module-level. */
function makeWorktree(): Worktree {
  nextId += 1;
  return {
    id: `wt-${nextId}`,
    projectId: "project",
    parentId: null,
    branch: `feature/${nextId}`,
    title: `Worktree ${nextId}`,
    path: `/tmp/wt-${nextId}`,
    isMain: false,
    hidden: false,
    createdAt: "now",
  } as Worktree;
}

function Row({ worktree }: { worktree: Worktree }) {
  const { probes, panel } = useWorktreeRowSections(worktree, worktree.title ?? "", false);
  return (
    <div>
      {probes}
      <div data-testid="panel">{panel}</div>
    </div>
  );
}

function installPlugin(ui: Record<string, unknown>): void {
  const definition = { name: "sections", ui, __apiVersion: "1.0.0" } as unknown as PluginDefinition;
  setPluginsForScope("global", null, [
    {
      pluginId: "sections",
      version: "1.0.0",
      scope: "global",
      status: "loaded",
      config: {},
      definition,
    },
  ]);
}

beforeEach(() => {
  mocks.activateTabLocation.mockReset();
  mocks.exitBoard.mockReset();
  mocks.listScratchpads.mockReset().mockResolvedValue([]);
  mocks.listWhiteboards.mockReset().mockResolvedValue([]);
  mocks.openScratchpadFile.mockReset();
  mocks.openWhiteboard.mockReset();
  mocks.openPorts = [];
  mocks.projectTabs = [];
  mocks.compact = false;
});

afterEach(() => {
  cleanup();
  clearPlugins();
  setPluginRuntimeSdk(null);
});

describe("worktree row sections", () => {
  it("shows a chip only for sections with something in them", async () => {
    const worktree = makeWorktree();
    mocks.openPorts = [
      { port: 5173, process: "vite", pid: 1, tabId: "tab-1", worktreeId: worktree.id },
      // Owned by no visible terminal tab (the server's own listener): not shown.
      { port: 1420, process: "pragma-server", pid: 2, tabId: "internal", worktreeId: worktree.id },
    ];
    mocks.projectTabs = [
      { id: "tab-1", worktreeId: worktree.id, kind: "terminal", title: "Vite server" },
    ];
    mocks.listWhiteboards.mockResolvedValue([{ id: "board-1", title: "Architecture" }]);

    render(<Row worktree={worktree} />);

    expect(await screen.findByRole("button", { name: "Whiteboards (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ports (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Scratchpads/ })).not.toBeInTheDocument();
    expect(mocks.listScratchpads).toHaveBeenCalledWith(worktree.id);
  });

  it("renders no panel while every list is empty or loading", async () => {
    mocks.listWhiteboards.mockReturnValue(new Promise(() => {}));
    render(<Row worktree={makeWorktree()} />);

    await waitFor(() => expect(mocks.listScratchpads).toHaveBeenCalled());
    expect(screen.getByTestId("panel")).toBeEmptyDOMElement();
  });

  it("opens a whiteboard in the row's worktree from its expanded body", async () => {
    const worktree = makeWorktree();
    mocks.listWhiteboards.mockResolvedValue([{ id: "board-1", title: "Architecture" }]);
    render(<Row worktree={worktree} />);

    const chip = await screen.findByRole("button", { name: "Whiteboards (1)" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");

    const body = screen.getByRole("region", { name: "Whiteboards" });
    fireEvent.click(within(body).getByRole("button", { name: "Architecture" }));

    expect(mocks.exitBoard).toHaveBeenCalledOnce();
    expect(mocks.openWhiteboard).toHaveBeenCalledWith("board-1", "Architecture", worktree.id);
  });

  it("opens a scratchpad in the row's worktree", async () => {
    const worktree = makeWorktree();
    mocks.listScratchpads.mockResolvedValue([
      { id: "pad-1", title: "Plan", filePath: ".pragma/scratchpads/plan.mdx" },
    ]);
    render(<Row worktree={worktree} />);

    fireEvent.click(await screen.findByRole("button", { name: "Scratchpads (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    expect(mocks.openScratchpadFile).toHaveBeenCalledWith(
      ".pragma/scratchpads/plan.mdx",
      "Plan",
      worktree.id,
    );
  });

  it("activates the owning terminal tab from a port", async () => {
    const worktree = makeWorktree();
    mocks.openPorts = [
      { port: 5173, process: "vite", pid: 1, tabId: "tab-1", worktreeId: worktree.id },
    ];
    mocks.projectTabs = [{ id: "tab-1", worktreeId: worktree.id, kind: "terminal", title: "" }];
    render(<Row worktree={worktree} />);

    fireEvent.click(await screen.findByRole("button", { name: "Ports (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /5173/ }));

    expect(mocks.activateTabLocation).toHaveBeenCalledWith("project", worktree.id, "tab-1");
  });

  it("shows nothing and lists nothing in the compact layout", () => {
    mocks.compact = true;
    mocks.listWhiteboards.mockResolvedValue([{ id: "board-1", title: "Architecture" }]);
    render(<Row worktree={makeWorktree()} />);

    expect(screen.getByTestId("panel")).toBeEmptyDOMElement();
    expect(mocks.listWhiteboards).not.toHaveBeenCalled();
  });

  it("renders plugin sections against the row's worktree", async () => {
    setPluginRuntimeSdk({} as PragmaClient);
    const worktree = makeWorktree();
    const guard = vi.fn((ctx: { worktree: PluginWorktree }) => ctx.worktree.id === worktree.id);
    installPlugin({
      worktreeSections: [
        { id: "ci", title: "CI", component: Body, useCount: () => 2, when: guard },
        { id: "empty", title: "Empty", component: Body, useCount: () => 0 },
        { id: "notes", title: "Notes", component: Body },
      ],
    });
    render(<Row worktree={worktree} />);

    const ci = await screen.findByRole("button", { name: "CI (2)" });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: expect.objectContaining({ id: worktree.id }) }),
    );
    expect(screen.queryByRole("button", { name: /Empty/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();

    fireEvent.click(ci);
    expect(screen.getByText(`Body for ${worktree.branch}`)).toBeInTheDocument();
  });

  it("hides a plugin section whose count hook throws", async () => {
    setPluginRuntimeSdk({} as PragmaClient);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installPlugin({
      worktreeSections: [
        {
          id: "broken",
          title: "Broken",
          component: () => null,
          useCount: () => {
            throw new Error("boom");
          },
        },
        { id: "ok", title: "Ok", component: () => null, useCount: () => 1 },
      ],
    });
    render(<Row worktree={makeWorktree()} />);

    expect(await screen.findByRole("button", { name: "Ok (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Broken/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/crashed/)).not.toBeInTheDocument();
  });
});
