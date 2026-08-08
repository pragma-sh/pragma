import type { KeyboardEvent } from "react";

import type { Worktree } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listPluginAgentsMock = vi.fn();
const resolvePluginAgentModelsMock = vi.fn();
const githubFetchAndSyncMock = vi.fn();
const startCreationMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  githubFetchAndSync: (...args: unknown[]) => githubFetchAndSyncMock(...args),
}));

vi.mock("@/state/worktree-creation-context", () => ({
  useWorktreeCreation: () => ({
    creation: null,
    startCreation: startCreationMock,
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/plugins/agents", () => ({
  usePluginAgents: () => listPluginAgentsMock(),
  resolvePluginAgentModels: (agentId: string) => resolvePluginAgentModelsMock(agentId),
}));

// The TipTap editor is unrelated to this behavior; a textarea keeps it focused.
vi.mock("@/components/github/MarkdownEditor", () => ({
  MarkdownEditor: ({
    onChange,
    onKeyDown,
    value,
  }: {
    onChange: (value: string) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    value: string;
  }) => (
    <textarea
      aria-label="Prompt"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      value={value}
    />
  ),
}));

const newWorktree: Worktree = {
  id: "wt-new",
  projectId: "p",
  parentId: "main",
  branch: "feature",
  title: "Feature",
  path: "/repo/.pragma/worktrees/feature",
  isMain: false,
  hidden: false,
  createdAt: "2026-01-02",
};

const workspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  selectedWorktree: { id: "main", isMain: true } as Partial<Worktree>,
  worktrees: {
    p: [
      {
        ...newWorktree,
        id: "main",
        branch: "main",
        title: null,
        isMain: true,
        parentId: null,
      },
    ],
  },
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

describe("CreateWorktreeDialog", () => {
  beforeEach(() => {
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
    ]);
    resolvePluginAgentModelsMock.mockResolvedValue([
      { id: "sonnet", name: "Sonnet", reasoning: [] },
    ]);
    githubFetchAndSyncMock.mockResolvedValue({
      branch: "main",
      ahead: 0,
      behind: 0,
      hasUpstream: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("names the parent worktree in the heading and keeps the fields in order", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "New worktree at main" })).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toBeInTheDocument();
    expect(screen.getByLabelText("Display title")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Claude"),
    );
  });

  it("opens the agent selector", async () => {
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    const trigger = await screen.findByRole("button", { name: "Agent" });
    await waitFor(() => expect(trigger).toHaveTextContent("Claude"));
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(await screen.findByRole("menuitem", { name: /OpenCode/ })).toBeInTheDocument();
  });

  it("hands the run off with the prompt and agent, then closes right away", async () => {
    const onOpenChange = vi.fn();
    render(<CreateWorktreeDialog open onOpenChange={onOpenChange} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Feature" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    await waitFor(() =>
      expect(startCreationMock).toHaveBeenCalledWith({
        projectId: "p",
        parentWorktreeId: "main",
        branch: "feature",
        title: "Feature",
        prompt: "Do the thing",
        agent: expect.objectContaining({ id: "claude" }),
        modelSelection: { modelId: null, reasoningId: null },
        syncWorktreeId: null,
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("hands off an empty prompt when none is written", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    await waitFor(() =>
      expect(startCreationMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: "" })),
    );
  });

  it("disables submit until a branch name is entered", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    expect(screen.getByRole("button", { name: /Create worktree/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    expect(screen.getByRole("button", { name: /Create worktree/ })).toBeEnabled();
  });

  it("asks to pull when main is behind and passes the sync target to the flow", async () => {
    githubFetchAndSyncMock.mockResolvedValue({
      branch: "main",
      ahead: 0,
      behind: 2,
      hasUpstream: true,
    });
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    expect(await screen.findByText("Main is behind remote")).toBeInTheDocument();
    expect(startCreationMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sync and create" }));

    await waitFor(() =>
      expect(startCreationMock).toHaveBeenCalledWith(
        expect.objectContaining({ syncWorktreeId: "main" }),
      ),
    );
  });

  it("skips the sync when the user creates without syncing", async () => {
    githubFetchAndSyncMock.mockResolvedValue({
      branch: "main",
      ahead: 1,
      behind: 1,
      hasUpstream: true,
    });
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create without syncing" }));

    await waitFor(() =>
      expect(startCreationMock).toHaveBeenCalledWith(
        expect.objectContaining({ syncWorktreeId: null }),
      ),
    );
  });
});
