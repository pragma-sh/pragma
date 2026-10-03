import type { Worktree } from "@pragma-sh/constants";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { contextResolveMock } from "@/test/prompt-editor";
import { installMemoryLocalStorage } from "@/test/storage";

const listPluginAgentsMock = vi.fn();
const resolvePluginAgentModelsMock = vi.fn();
const githubFetchAndSyncMock = vi.fn();
const startCreationMock = vi.fn();
const refreshProjectMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  githubFetchAndSync: (...args: unknown[]) => githubFetchAndSyncMock(...args),
}));

const createFanoutMock = vi.fn();
const openComparisonMock = vi.fn();

vi.mock("@/state/fanouts-context", () => ({
  useFanouts: () => ({
    fanouts: [],
    comparingFanoutId: null,
    openComparison: openComparisonMock,
    closeComparison: vi.fn(),
    create: createFanoutMock,
    retry: vi.fn(),
    cancel: vi.fn(),
    send: vi.fn(),
    pick: vi.fn(),
  }),
}));

const clearDraftMock = vi.fn();
/** The failed-run request the provider republishes for "Try again"; null by default. */
let publishedDraft: unknown = null;

vi.mock("@/state/worktree-creation-context", () => ({
  useWorktreeCreation: () => ({
    creation: null,
    draft: publishedDraft,
    startCreation: startCreationMock,
    dismiss: vi.fn(),
    clearDraft: clearDraftMock,
  }),
}));

vi.mock("@/plugins/agents", () => ({
  usePluginAgents: () => listPluginAgentsMock(),
  resolvePluginAgentModels: (agentId: string) => resolvePluginAgentModelsMock(agentId),
  resolvePluginAgentOptions: async () => ({
    modes: [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ],
    permissionModes: [{ id: "auto", name: "Auto" }],
    slashCommands: [{ name: "review" }],
  }),
}));

vi.mock("@/plugins/context-providers", async () => {
  const { testContextProviders } = await import("@/test/prompt-editor");
  return { useContextProviders: () => testContextProviders };
});

// The TipTap editor is unrelated to this behavior; a textarea keeps it focused.
vi.mock("@/components/github/MarkdownEditor", async () => ({
  MarkdownEditor: (await import("@/test/prompt-editor")).MarkdownEditorStub,
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

const selectWorktreeMock = vi.fn();

const workspaceMock = {
  refreshProject: (...args: unknown[]) => refreshProjectMock(...args),
  selectWorktree: (...args: unknown[]) => selectWorktreeMock(...args),
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

/** Types `text` ending in an `@query`, then picks the first match with Enter. */
async function pickMention(text: string) {
  const prompt = screen.getByLabelText("Prompt");
  fireEvent.change(prompt, { target: { value: text } });
  await screen.findByRole("region", { name: "Docs" });
  fireEvent.keyDown(prompt, { key: "Enter" });
}

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
    refreshProjectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    publishedDraft = null;
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
    await screen.findByRole("button", { name: "Agent mode" });

    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Feature" } });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "/review Do the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

    await waitFor(() =>
      expect(startCreationMock).toHaveBeenCalledWith({
        projectId: "p",
        parentWorktreeId: "main",
        branch: "feature",
        title: "Feature",
        // The prompt stays verbatim; mode and permission mode ride on the selection.
        prompt: "/review Do the thing",
        agent: expect.objectContaining({ id: "claude" }),
        modelSelection: {
          modelId: null,
          reasoningId: null,
          modeId: "build",
          permissionModeId: "auto",
          slashCommand: null,
        },
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

  it("restores a failed run's input when its draft is published", async () => {
    publishedDraft = {
      projectId: "p",
      parentWorktreeId: "main",
      branch: "feature",
      title: "Feature",
      prompt: "Do the thing",
      agent: { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
      modelSelection: { modelId: null, reasoningId: null },
      syncWorktreeId: null,
    };
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText("Branch name")).toHaveValue("feature");
    expect(screen.getByLabelText("Display title")).toHaveValue("Feature");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Do the thing");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("OpenCode"),
    );
    // Consumed once, so reopening the dialog later starts from a clean form.
    expect(clearDraftMock).toHaveBeenCalled();
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

describe("CreateWorktreeDialog history", () => {
  beforeAll(installMemoryLocalStorage);

  beforeEach(() => {
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
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
    createFanoutMock.mockResolvedValue({
      fanout: { id: "f1", parentWorktreeId: "main", members: [] },
      partial: false,
      failures: [],
    });
    refreshProjectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("always offers history, with an empty state before anything is submitted", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(screen.getByText(/No submitted prompts yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Branch name")).toBeInTheDocument();
  });

  it("lists a submitted run and fills the form back out from it", async () => {
    const { rerender } = render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Claude"),
    );
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Add token refresh. Then test it." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));
    await waitFor(() => expect(startCreationMock).toHaveBeenCalled());

    rerender(<CreateWorktreeDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByLabelText("Branch name")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const item = screen.getByRole("button", { name: /feature/ });
    expect(item).toHaveTextContent("Add token refresh.");
    expect(item).not.toHaveTextContent("Then test it.");
    fireEvent.click(item);

    expect(screen.getByLabelText("Branch name")).toHaveValue("feature");
    expect(screen.getByLabelText("Prompt")).toHaveValue("Add token refresh. Then test it.");
  });

  it("restores a fanout run with every attempt row", async () => {
    const { rerender } = render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "fan" } });
    fireEvent.change(screen.getByLabelText("Display title"), { target: { value: "Fan title" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));
    await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));

    rerender(<CreateWorktreeDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /Fan title/ }));

    expect(screen.getByRole("tab", { name: "Fan out" })).toHaveAttribute("data-state", "active");
    expect(screen.getAllByRole("button", { name: "Remove attempt" })).toHaveLength(3);
    expect(screen.getByLabelText("Branch name")).toHaveValue("fan");
  });
});

describe("CreateWorktreeDialog fanout mode", () => {
  beforeEach(() => {
    listPluginAgentsMock.mockReturnValue([
      { id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] },
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    resolvePluginAgentModelsMock.mockResolvedValue([
      { id: "sonnet", name: "Sonnet", reasoning: [] },
    ]);
    createFanoutMock.mockResolvedValue({
      fanout: { id: "f1", parentWorktreeId: "main", members: [] },
      partial: false,
      failures: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts in single mode and only shows attempt rows after switching", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "Standard" })).toHaveAttribute("data-state", "active");
    expect(screen.queryByText("Attempts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create worktree/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));

    expect(screen.getByText("Attempts")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Remove attempt" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Create & Fanout/ })).toBeInTheDocument();
  });

  it("preserves the prompt when switching modes", () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Implement token refresh" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));

    expect(screen.getByLabelText("Prompt")).toHaveValue("Implement token refresh");
  });

  it("adds and removes attempt rows down to the minimum", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));

    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    expect(screen.getAllByRole("button", { name: "Remove attempt" })).toHaveLength(4);

    for (const remove of screen.getAllByRole("button", { name: "Remove attempt" }).slice(0, 2)) {
      fireEvent.click(remove);
    }
    expect(screen.getAllByRole("button", { name: "Remove attempt" })).toHaveLength(2);
    // The minimum is enforced by disabling removal, not by silently dropping to one.
    for (const remove of screen.getAllByRole("button", { name: "Remove attempt" })) {
      expect(remove).toBeDisabled();
    }
  });

  it("always creates a new coordination parent without opening the comparison", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });

    // A branch name is required: the fanout always branches its own parent.
    expect(screen.getByRole("button", { name: /Create & Fanout/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "fanout/token-refresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

    await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));
    const request = createFanoutMock.mock.calls[0]![0] as {
      parent: { kind: string; branch?: string; sourceWorktreeId?: string; title?: string | null };
      prompt: string;
      members: unknown[];
    };
    expect(request.parent).toEqual({
      kind: "new",
      sourceWorktreeId: "main",
      branch: "fanout/token-refresh",
      title: null,
    });
    expect(request.prompt).toBe("Do the thing");
    expect(request.members).toHaveLength(2);
    await waitFor(() => expect(refreshProjectMock).toHaveBeenCalledWith("p"));
    expect(openComparisonMock).not.toHaveBeenCalled();
  });

  it("sends !! commands to the host with a run id so Skip can cancel them", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Do the thing !!`bun run test`" },
    });
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "fanout/token-refresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

    await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));
    const request = createFanoutMock.mock.calls[0]![0] as {
      prompt: string;
      commandRunId: string | null;
    };
    // The host runs the commands in each attempt's worktree; the prompt stays verbatim.
    expect(request.prompt).toBe("Do the thing !!`bun run test`");
    expect(request.commandRunId).toEqual(expect.any(String));
  });

  it("sends no run id when the prompt has no commands", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "fanout/token-refresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

    await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));
    expect(
      (createFanoutMock.mock.calls[0]![0] as { commandRunId: unknown }).commandRunId,
    ).toBeNull();
  });

  it("stays open until fanout worktrees and tabs are loaded", async () => {
    let finishCreate: ((value: unknown) => void) | undefined;
    let finishRefresh: (() => void) | undefined;
    createFanoutMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    refreshProjectMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    render(<CreateWorktreeDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "fanout/test" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

    expect(screen.getByRole("button", { name: /Working/ })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      finishCreate?.({
        fanout: { id: "f1", parentWorktreeId: "fanout-parent", members: [] },
        partial: false,
        failures: [],
      });
    });

    await waitFor(() => expect(refreshProjectMock).toHaveBeenCalledWith("p"));
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => finishRefresh?.());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(selectWorktreeMock).toHaveBeenCalledWith("fanout-parent");
  });

  it("has no ceiling on attempt rows", () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));

    for (let index = 0; index < 10; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    }

    expect(screen.getAllByRole("button", { name: "Remove attempt" })).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Add agent" })).toBeEnabled();
  });

  it("offers the attempts' shared slash commands and sends the prompt verbatim", async () => {
    render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "fanout/x" } });
    const prompt = screen.getByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "/re" } });

    const menu = await screen.findByRole("list", { name: "Slash commands" });
    expect(menu).toHaveTextContent("/review");
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(prompt).toHaveValue("/review ");
    fireEvent.change(prompt, { target: { value: "/review the auth module" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

    await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));
    expect((createFanoutMock.mock.calls[0]![0] as { prompt: string }).prompt).toBe(
      "/review the auth module",
    );
  });

  describe("@ context", () => {
    const docsBlock = '<context mention="@auth-guide" source="Docs">\nAuth guide body\n</context>';

    beforeEach(() => {
      contextResolveMock.mockResolvedValue("Auth guide body");
      githubFetchAndSyncMock.mockResolvedValue({
        branch: "main",
        ahead: 0,
        behind: 0,
        hasUpstream: true,
      });
    });

    afterEach(() => {
      publishedDraft = null;
    });

    it("attaches picked context to a single worktree's agent prompt", async () => {
      render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature" } });
      await pickMention("fix @au");
      expect(screen.getByLabelText("Prompt")).toHaveValue("fix @auth-guide ");
      fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));

      await waitFor(() => expect(startCreationMock).toHaveBeenCalled());
      expect(startCreationMock.mock.calls[0]![0]).toMatchObject({
        prompt: `fix @auth-guide\n\n${docsBlock}`,
      });
      // The new worktree branches from its parent, so `@` searched the parent.
      expect(contextResolveMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: expect.objectContaining({ id: "main" }) }),
      );
    });

    it("attaches picked context to every fanout attempt's prompt", async () => {
      render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("tab", { name: "Fan out" }));
      fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "fanout/x" } });
      await pickMention("fix @au");
      fireEvent.click(screen.getByRole("button", { name: /Create & Fanout/ }));

      await waitFor(() => expect(createFanoutMock).toHaveBeenCalledTimes(1));
      expect((createFanoutMock.mock.calls[0]![0] as { prompt: string }).prompt).toBe(
        `fix @auth-guide\n\n${docsBlock}`,
      );
    });

    it("restores a failed run's prompt without its context and keeps the context", async () => {
      publishedDraft = {
        projectId: "p",
        parentWorktreeId: "main",
        branch: "feature",
        title: null,
        prompt: `fix @auth-guide\n\n${docsBlock}`,
        agent: null,
        modelSelection: null,
        syncWorktreeId: null,
      };
      render(<CreateWorktreeDialog open onOpenChange={vi.fn()} />);
      expect(screen.getByLabelText("Prompt")).toHaveValue("fix @auth-guide");

      fireEvent.click(screen.getByRole("button", { name: /Create worktree/ }));
      await waitFor(() => expect(startCreationMock).toHaveBeenCalled());
      expect(startCreationMock.mock.calls[0]![0]).toMatchObject({
        prompt: `fix @auth-guide\n\n${docsBlock}`,
      });
      expect(contextResolveMock).not.toHaveBeenCalled();
    });
  });
});
