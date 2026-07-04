import type { KeyboardEvent } from "react";

import type { Worktree } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NewSessionDeepLinkDetail } from "@/lib/deep-link";

const listPluginAgentsMock = vi.fn();
const resolvePluginAgentModelsMock = vi.fn();
const startSessionMock = vi.fn();

vi.mock("@/plugins/agents", () => ({
  listPluginAgents: () => listPluginAgentsMock(),
  resolvePluginAgentModels: (agentId: string) => resolvePluginAgentModelsMock(agentId),
}));

// The TipTap editor is unrelated to dialog seeding; a textarea keeps the test focused.
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

const mainWorktree: Worktree = {
  id: "main",
  projectId: "p",
  parentId: null,
  branch: "main",
  title: null,
  path: "/repo",
  isMain: true,
  hidden: false,
  createdAt: "2026-01-01",
};

const linkedWorktree: Worktree = {
  id: "wt-link",
  projectId: "p",
  parentId: "main",
  branch: "agent-control",
  title: "Agent control",
  path: "/repo/.pragma/worktrees/agent-control",
  isMain: false,
  hidden: false,
  createdAt: "2026-01-02",
};

const otherProjectWorktree: Worktree = {
  ...linkedWorktree,
  projectId: "p-other",
};

interface WorkspaceMock {
  selectedProjectId: string;
  selectedWorktreeId: string;
  worktrees: Record<string, Worktree[]>;
  startSession: typeof startSessionMock;
}

let workspaceMock: WorkspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  worktrees: { p: [mainWorktree, linkedWorktree] },
  startSession: startSessionMock,
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { NewAgentSessionDialog } from "./NewAgentSessionDialog";

const deepLinkInitial: NewSessionDeepLinkDetail = {
  agentId: "opencode",
  modelId: null,
  reasoningId: null,
  worktreeId: "wt-link",
  message: "Hello",
};

describe("NewAgentSessionDialog", () => {
  beforeEach(() => {
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    resolvePluginAgentModelsMock.mockResolvedValue([
      { id: "sonnet", name: "Sonnet", reasoning: [] },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree, linkedWorktree] },
      startSession: startSessionMock,
    };
  });

  it("selects an agent-only deep link with no worktree or message", async () => {
    render(
      <NewAgentSessionDialog
        open
        onOpenChange={vi.fn()}
        initial={{
          agentId: "opencode",
          modelId: null,
          reasoningId: null,
          worktreeId: null,
          message: null,
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("OpenCode"),
    );
  });

  it("applies deep-link values that arrive after the dialog is already open", async () => {
    const { rerender } = render(
      <NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />,
    );

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue(""));

    rerender(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue("Hello"));
    expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("OpenCode");
    expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control");
  });

  it("keeps the deep-link worktree selected when worktree options load later", async () => {
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree] },
      startSession: startSessionMock,
    };
    const { rerender } = render(
      <NewAgentSessionDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />,
    );

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue("Hello"));
    expect(screen.getByRole("combobox", { name: "Worktree" })).not.toHaveTextContent(
      "Agent control",
    );

    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "wt-link",
      worktrees: { p: [mainWorktree, linkedWorktree] },
      startSession: startSessionMock,
    };
    rerender(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control"),
    );
  });

  it("opens the worktree dropdown after the agent menu has been opened and closed", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);

    // Open then close the agent menu. A modal Radix menu would leave
    // `body { pointer-events: none }` stuck, blocking the worktree Select.
    const agentTrigger = await screen.findByRole("button", { name: "Agent" });
    await user.click(agentTrigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));

    await user.click(screen.getByRole("combobox", { name: "Worktree" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Agent control/ })).toBeInTheDocument(),
    );
  });

  it("labels a deep-link worktree that is loaded before its project selection renders", async () => {
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree], "p-other": [otherProjectWorktree] },
      startSession: startSessionMock,
    };

    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control"),
    );
    expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("OpenCode");
  });
});
