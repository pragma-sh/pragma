import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoRef } from "@pragma-sh/constants";
import type { ChecksStatus, PullRequestSummary } from "@/lib/github";

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
vi.mock("@/lib/agent-model-selection", () => ({ modelSelectionLabel: () => "Chosen model" }));

import { CiWatchControls } from "./CiWatchControls";
import { ciWatches, ciWatchKey } from "@/state/ci-watch-store";

const repo: GitHubRepoRef = {
  owner: "owner",
  repo: "repo",
  defaultBranch: "main",
  headBranch: "branch",
  parentBranch: null,
};
const pr = { number: 1, state: "open", headRef: "branch", merged: false } as PullRequestSummary;
const checks: ChecksStatus = {
  state: "pending",
  total: 1,
  pending: 1,
  failed: 0,
  passed: 0,
  items: [],
};
const key = ciWatchKey("worktree", repo, 1);

afterEach(() => {
  cleanup();
  ciWatches.cancel(key);
});

describe("CI watch controls", () => {
  it("only offers watch setup when CI checks are reported", () => {
    const { rerender } = render(
      <CiWatchControls repo={repo} pr={pr} worktreeId="worktree" checks={null} />,
    );
    expect(screen.queryByRole("button", { name: "Watch and fix" })).not.toBeInTheDocument();
    rerender(<CiWatchControls repo={repo} pr={pr} worktreeId="worktree" checks={checks} />);
    expect(screen.getByRole("button", { name: "Watch and fix" })).toBeInTheDocument();
  });

  it("sets up the chosen harness/model and requires confirmation to cancel", async () => {
    render(<CiWatchControls repo={repo} pr={pr} worktreeId="worktree" checks={checks} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch and fix" }));
    expect(screen.getByRole("button", { name: "Standard harness picker" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));
    expect(ciWatches.get(key)?.modelSelection.modelId).toBe("model");
    expect(await screen.findByRole("status")).toHaveTextContent("Watching CI");
    expect(screen.getByRole("status")).toHaveTextContent("Chosen harness · Chosen model");
    fireEvent.click(screen.getByRole("button", { name: "Cancel watch" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(ciWatches.get(key)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep watching" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(ciWatches.get(key)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel watch" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel watch" }),
    );
    expect(ciWatches.get(key)).toBeUndefined();
  });
});
