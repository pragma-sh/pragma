import type { KeyboardEvent } from "react";

import type { Worktree } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listAgentsMock = vi.fn();
const createWorktreeMock = vi.fn();
const startSessionMock = vi.fn();
const refreshProjectMock = vi.fn();
const selectWorktreeMock = vi.fn();
const createTerminalTabMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listAgents: () => listAgentsMock(),
  createWorktree: (...args: unknown[]) => createWorktreeMock(...args),
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
  refreshProject: refreshProjectMock,
  startSession: startSessionMock,
  selectWorktree: selectWorktreeMock,
  createTerminalTab: createTerminalTabMock,
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

describe("CreateWorktreeDialog", () => {
  beforeEach(() => {
    listAgentsMock.mockResolvedValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
    ]);
    createWorktreeMock.mockResolvedValue(newWorktree);
    refreshProjectMock.mockResolvedValue(undefined);
    startSessionMock.mockResolvedValue({ id: "tab" });
    createTerminalTabMock.mockResolvedValue({ id: "tab" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps branch, title and agent at the top with the prompt below", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "New worktree at" })).toBeInTheDocument();
    expect(screen.getByLabelText("Branch name")).toBeInTheDocument();
    expect(screen.getByLabelText("Display title")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("Claude"),
    );
  });

  it("opens the agent selector", async () => {
    listAgentsMock.mockResolvedValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    const trigger = await screen.findByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(trigger).toHaveTextContent("Claude"));
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(await screen.findByRole("option", { name: "OpenCode" })).toBeInTheDocument();
  });

  it("launches an agent session when a prompt is written", async () => {
    const onOpenChange = vi.fn();
    render(<CreateWorktreeDialog open onOpenChange={onOpenChange} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Feature" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    await waitFor(() =>
      expect(createWorktreeMock).toHaveBeenCalledWith("p", "main", "feature", "Feature"),
    );
    await waitFor(() =>
      expect(startSessionMock).toHaveBeenCalledWith(
        "wt-new",
        expect.objectContaining({ id: "claude" }),
        "Do the thing",
      ),
    );
    expect(createTerminalTabMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not start a session when the prompt is empty", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    await waitFor(() => expect(createWorktreeMock).toHaveBeenCalled());
    await waitFor(() => expect(createTerminalTabMock).toHaveBeenCalledWith("wt-new"));
    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-new");
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it("disables submit until a branch name is entered", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("Claude"),
    );

    expect(screen.getByRole("button", { name: /Create worktree/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    expect(screen.getByRole("button", { name: /Create worktree/ })).toBeEnabled();
  });
});
