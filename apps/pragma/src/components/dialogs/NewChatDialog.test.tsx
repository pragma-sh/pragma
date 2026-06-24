import type { KeyboardEvent } from "react";

import type { Worktree } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NewChatDeepLinkDetail } from "@/lib/deep-link";

const listAgentsMock = vi.fn();
const startChatMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listAgents: () => listAgentsMock(),
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
  startChat: typeof startChatMock;
}

let workspaceMock: WorkspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  worktrees: { p: [mainWorktree, linkedWorktree] },
  startChat: startChatMock,
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { NewChatDialog } from "./NewChatDialog";

const deepLinkInitial: NewChatDeepLinkDetail = {
  agentId: "opencode",
  worktreeId: "wt-link",
  message: "Hello",
};

describe("NewChatDialog", () => {
  beforeEach(() => {
    listAgentsMock.mockResolvedValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree, linkedWorktree] },
      startChat: startChatMock,
    };
  });

  it("selects an agent-only deep link with no worktree or message", async () => {
    render(
      <NewChatDialog
        open
        onOpenChange={vi.fn()}
        initial={{ agentId: "opencode", worktreeId: null, message: null }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("OpenCode"),
    );
  });

  it("applies deep-link values that arrive after the dialog is already open", async () => {
    const { rerender } = render(<NewChatDialog open onOpenChange={vi.fn()} initial={null} />);

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue(""));

    rerender(<NewChatDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue("Hello"));
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("OpenCode");
    expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control");
  });

  it("keeps the deep-link worktree selected when worktree options load later", async () => {
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree] },
      startChat: startChatMock,
    };
    const { rerender } = render(
      <NewChatDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />,
    );

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue("Hello"));
    expect(screen.getByRole("combobox", { name: "Worktree" })).not.toHaveTextContent(
      "Agent control",
    );

    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "wt-link",
      worktrees: { p: [mainWorktree, linkedWorktree] },
      startChat: startChatMock,
    };
    rerender(<NewChatDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control"),
    );
  });

  it("labels a deep-link worktree that is loaded before its project selection renders", async () => {
    workspaceMock = {
      selectedProjectId: "p",
      selectedWorktreeId: "main",
      worktrees: { p: [mainWorktree], "p-other": [otherProjectWorktree] },
      startChat: startChatMock,
    };

    render(<NewChatDialog open onOpenChange={vi.fn()} initial={deepLinkInitial} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Worktree" })).toHaveTextContent("Agent control"),
    );
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("OpenCode");
  });
});
