import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiWatch } from "@pragma-sh/constants";
import type { MergeActionState } from "@/components/github/MergeActionControls";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";

const { tauri } = vi.hoisted(() => ({
  tauri: { armCiWatch: vi.fn(), clearCiWatch: vi.fn() },
}));

vi.mock("@/components/agents/AgentModelSelector", () => ({
  AgentModelSelector: () => <button>Standard harness picker</button>,
}));
vi.mock("@/hooks/use-agent-selection", () => ({
  useAgentSelection: () => ({
    agents: [],
    modelsByAgent: {},
    agentId: "agent",
    modelSelection: { modelId: "model", reasoningId: null },
    selectedAgent: { id: "agent", name: "Chosen harness", start: [], iconDataUrl: null },
    handleAgentChange: vi.fn(),
    loadModels: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-agents-list", () => ({
  useAgentsList: () => [{ id: "agent", name: "Chosen harness", start: [], iconDataUrl: null }],
}));
vi.mock("@/lib/tauri", () => tauri);

import { CiWatchControls } from "./CiWatchControls";
import { ciWatches } from "@/state/ci-watch-store";

const pr = {
  number: 1,
  state: "open",
  headRef: "branch",
  merged: false,
  mergeable: true,
} as PullRequestSummary;
const passing: ChecksStatus = {
  state: "success",
  total: 1,
  pending: 0,
  failed: 0,
  passed: 1,
  items: [],
};
const checks: ChecksStatus = {
  state: "pending",
  total: 1,
  pending: 1,
  failed: 0,
  passed: 0,
  items: [],
};

function record(overrides: Partial<CiWatch> = {}): CiWatch {
  return {
    worktreeId: "worktree",
    mode: "watchMerge",
    agentId: "agent",
    modelId: "model",
    reasoningId: null,
    prNumber: 1,
    status: "watching",
    attempts: 0,
    error: null,
    fixTabId: null,
    fixHeadSha: null,
    createdAt: 0,
    updatedAt: 1,
    ...overrides,
  };
}

function mergeState(overrides: Partial<MergeActionState> = {}): MergeActionState {
  return {
    label: "Merge pull request",
    disabled: false,
    merging: false,
    allowed: true,
    stack: null,
    target: { owner: "owner", repo: "repo" },
    ...overrides,
  };
}

const onMerge = vi.fn();

function controls({
  withChecks = checks,
  withPr = pr,
  merge = mergeState(),
}: {
  withChecks?: ChecksStatus | null;
  withPr?: PullRequestSummary;
  merge?: MergeActionState;
} = {}) {
  return (
    <CiWatchControls
      checks={withChecks}
      merge={merge}
      onMerge={onMerge}
      pr={withPr}
      worktreeId="worktree"
    />
  );
}

function renderControls(options: Parameters<typeof controls>[0] = {}) {
  return render(controls(options));
}

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More CI watch options" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

beforeEach(() => {
  tauri.armCiWatch.mockImplementation(async (input: Partial<CiWatch>) => record(input));
  tauri.clearCiWatch.mockResolvedValue({ cleared: true });
});

afterEach(() => {
  cleanup();
  ciWatches.remove("worktree");
  vi.clearAllMocks();
});

describe("CI watch controls", () => {
  it("only offers watch setup while CI is failing or running", () => {
    const { rerender } = renderControls({ withChecks: null });
    expect(screen.queryByRole("button", { name: /Watch, fix and merge/ })).not.toBeInTheDocument();
    rerender(controls({ withChecks: passing }));
    expect(screen.queryByRole("button", { name: /Watch, fix and merge/ })).not.toBeInTheDocument();
    rerender(controls());
    expect(screen.getByRole("button", { name: /Watch, fix and merge/ })).toBeInTheDocument();
    rerender(controls({ withChecks: { ...passing, state: "failure", failed: 1, passed: 0 } }));
    expect(screen.getByRole("button", { name: /Watch, fix and merge/ })).toBeInTheDocument();
  });

  it("offers no watch setup for a pull request with a merge conflict", () => {
    renderControls({ withPr: { ...pr, mergeable: false } });
    expect(screen.queryByRole("button", { name: /Watch, fix and merge/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More CI watch options" })).not.toBeInTheDocument();
  });

  it("keeps showing an armed watch once CI goes green or conflicts", () => {
    ciWatches.put(record());
    const { rerender } = renderControls({ withChecks: passing });
    expect(screen.getByRole("status")).toHaveTextContent("Watching CI");
    rerender(controls({ withPr: { ...pr, mergeable: false } }));
    expect(screen.getByRole("status")).toHaveTextContent("Watching CI");
  });

  it("keeps a plain merge in the menu", async () => {
    renderControls();
    openMenu();
    const item = await screen.findByRole("menuitem", { name: /Merge pull request/ });
    expect(item).toHaveTextContent("Merge now, without waiting for checks");
    fireEvent.click(item);
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(tauri.armCiWatch).not.toHaveBeenCalled();
  });

  it("disables the menu's plain merge while it is unavailable", async () => {
    renderControls({ merge: mergeState({ label: "Checking stack membership…", disabled: true }) });
    openMenu();
    const item = await screen.findByRole("menuitem", { name: /Checking stack membership/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("arms watch, fix and merge by default, then cancels with confirmation", async () => {
    renderControls();
    const primary = screen.getByRole("button", { name: /Watch, fix and merge/ });
    await waitFor(() => expect(primary).toBeEnabled());
    fireEvent.click(primary);
    expect(screen.getByRole("button", { name: "Standard harness picker" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));

    await waitFor(() =>
      expect(tauri.armCiWatch).toHaveBeenCalledWith({
        worktreeId: "worktree",
        mode: "watchMerge",
        agentId: "agent",
        modelId: "model",
        reasoningId: null,
        prNumber: 1,
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Watching CI · merges when all checks pass",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Chosen harness · model");

    fireEvent.click(screen.getByRole("button", { name: "Cancel watch" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel watch" }),
    );
    await waitFor(() => expect(tauri.clearCiWatch).toHaveBeenCalledWith("worktree"));
    expect(ciWatches.get("worktree")).toBeUndefined();
  });

  it("offers watch and fix without merging from the menu", async () => {
    renderControls();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Watch and fix/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));
    await waitFor(() =>
      expect(tauri.armCiWatch).toHaveBeenCalledWith(expect.objectContaining({ mode: "watch" })),
    );
  });

  it("disables merging without permission but keeps watch and fix", async () => {
    renderControls({ merge: mergeState({ allowed: false, disabled: true }) });
    expect(await screen.findByText(/don't have permission to merge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Watch, fix and merge/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More CI watch options" })).toBeEnabled();
  });

  it("shows the full reason a watch-merge stopped, and dismisses it", async () => {
    ciWatches.put(
      record({
        status: "disarmed",
        error: "The e2e check needs a staging secret.\nIt cannot be fixed from this branch.",
      }),
    );
    renderControls();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Merge could not be completed");
    expect(alert).toHaveTextContent("The e2e check needs a staging secret.");
    expect(alert).toHaveTextContent("It cannot be fixed from this branch.");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(ciWatches.get("worktree")).toBeUndefined());
  });
});
