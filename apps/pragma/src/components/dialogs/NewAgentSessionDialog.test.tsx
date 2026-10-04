import type { Worktree } from "@pragma-sh/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NewSessionDeepLinkDetail } from "@/lib/deep-link";
import { ContextProviderNotice } from "@pragma-sh/plugin/catalog";

import { contextResolveMock, ticketsSearchMock } from "@/test/prompt-editor";

const listPluginAgentsMock = vi.fn();
const resolvePluginAgentModelsMock = vi.fn();
const resolvePluginAgentOptionsMock = vi.fn();
const startSessionMock = vi.fn();
const runWorktreeCommandsMock = vi.fn();

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  runWorktreeCommands: (...args: unknown[]) => runWorktreeCommandsMock(...args),
}));

vi.mock("@/plugins/agents", () => ({
  listPluginAgents: () => listPluginAgentsMock(),
  resolvePluginAgentModels: (agentId: string) => resolvePluginAgentModelsMock(agentId),
  resolvePluginAgentOptions: (agentId: string) => resolvePluginAgentOptionsMock(agentId),
}));

vi.mock("@/plugins/context-providers", async () => {
  const { testContextProviders } = await import("@/test/prompt-editor");
  return { useContextProviders: () => testContextProviders };
});

// The TipTap editor is unrelated to dialog seeding; a textarea keeps the test focused.
vi.mock("@/components/github/MarkdownEditor", async () => ({
  MarkdownEditor: (await import("@/test/prompt-editor")).MarkdownEditorStub,
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
    resolvePluginAgentOptionsMock.mockResolvedValue({
      modes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
      permissionModes: [
        { id: "auto", name: "Auto" },
        { id: "ask", name: "Ask first" },
      ],
      slashCommands: [
        { name: "review", description: "Review changes" },
        { name: "init", description: "Write AGENTS.md" },
      ],
    });
    startSessionMock.mockResolvedValue({ id: "tab" });
    contextResolveMock.mockResolvedValue("Auth guide body");
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

  it("cycles the agent mode with Shift+Tab and shows the permission mode", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);

    const mode = await screen.findByRole("button", { name: "Agent mode" });
    expect(mode).toHaveTextContent("Build");
    expect(screen.getByRole("combobox", { name: "Permission mode" })).toHaveTextContent("Auto");

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(mode).toHaveTextContent("Plan");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(mode).toHaveTextContent("Build");
  });

  it("opens the slash-command picker while a command name is typed", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/re");
    const menu = await screen.findByRole("list", { name: "Slash commands" });
    expect(menu).toHaveTextContent("/review");
    expect(menu).not.toHaveTextContent("/init");

    await user.keyboard(" now");
    expect(screen.queryByRole("list", { name: "Slash commands" })).not.toBeInTheDocument();
  });

  it("launches with the slash command, mode, and permission mode", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    const mode = await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/review the auth module");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(mode).toHaveTextContent("Plan");
    await user.click(screen.getByRole("button", { name: /Start session/ }));

    await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
    const [, , prompt, selection] = startSessionMock.mock.calls[0]!;
    expect(prompt).toBe("the auth module");
    expect(selection).toMatchObject({
      slashCommand: "review",
      modeId: "plan",
      permissionModeId: "auto",
    });
  });

  it("inserts an @ mention picked from the context picker", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("read @au");
    const group = await screen.findByRole("region", { name: "Docs" });
    expect(group).toHaveTextContent("auth-guide");
    expect(group).not.toHaveTextContent("billing");

    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Prompt")).toHaveValue("read @auth-guide ");
    expect(screen.queryByRole("region", { name: "Docs" })).not.toBeInTheDocument();
  });

  it("keeps the picker open with a message when nothing matches", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("@zzz");
    expect(
      await screen.findByText('No files, issues, or pull requests match "zzz".'),
    ).toBeInTheDocument();
    await user.keyboard(" ");
    expect(screen.queryByText(/No files, issues/)).not.toBeInTheDocument();
  });

  it("shows a provider's notice alongside other providers' results", async () => {
    ticketsSearchMock.mockRejectedValueOnce(new ContextProviderNotice("Sign in to Tickets."));
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("@");
    expect(await screen.findByText("Sign in to Tickets.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Docs" })).toHaveTextContent("auth-guide");
  });

  it("appends resolved context for mentions still in the prompt", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("see @auth");
    await screen.findByRole("region", { name: "Docs" });
    await user.keyboard("{Enter}");
    await user.keyboard("please");
    await user.click(screen.getByRole("button", { name: /Start session/ }));

    await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
    const [, , prompt] = startSessionMock.mock.calls[0]!;
    expect(prompt).toBe(
      'see @auth-guide please\n\n<context mention="@auth-guide" source="Docs">\nAuth guide body\n</context>',
    );
    expect(contextResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: "a" }),
        worktree: { id: "main", path: "/repo", branch: "main" },
      }),
    );
  });

  it("drops context whose mention was deleted before launch", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    const prompt = screen.getByLabelText("Prompt");
    await user.click(prompt);
    await user.keyboard("@auth");
    await screen.findByRole("region", { name: "Docs" });
    await user.keyboard("{Enter}");
    await user.clear(prompt);
    await user.keyboard("nothing attached");
    await user.click(screen.getByRole("button", { name: /Start session/ }));

    await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
    expect(startSessionMock.mock.calls[0]![2]).toBe("nothing attached");
    expect(contextResolveMock).not.toHaveBeenCalled();
  });

  it("launches immediately and focused when no commands are given", async () => {
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={vi.fn()} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("plain");
    await user.click(screen.getByRole("button", { name: /Start session/ }));

    await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
    expect(startSessionMock.mock.calls[0]![4]).toEqual({ focus: true });
    expect(runWorktreeCommandsMock).not.toHaveBeenCalled();
  });

  it("runs `!!` command chips first and hands their output to the agent", async () => {
    runWorktreeCommandsMock.mockResolvedValue([
      {
        command: "git status",
        stdout: "clean\n",
        stderr: "",
        status: 0,
        durationMs: 40,
        cancelled: false,
      },
    ]);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<NewAgentSessionDialog open onOpenChange={onOpenChange} initial={null} />);
    await screen.findByRole("button", { name: "Agent mode" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("summarize !!`git status` please");
    await user.click(screen.getByRole("button", { name: /Start session/ }));

    await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runWorktreeCommandsMock).toHaveBeenCalledWith(
      "main",
      ["git status"],
      expect.any(String),
    );
    const [worktreeId, , prompt, , options] = startSessionMock.mock.calls[0]!;
    expect(worktreeId).toBe("main");
    expect(prompt).toMatch(/^summarize `git status` please\n\nBefore this session started/);
    expect(prompt).toContain(
      '<command-output command="git status" exit-code="0" duration="0.0s">\nclean\n</command-output>',
    );
    expect(options).toEqual({ focus: true });
  });
});
