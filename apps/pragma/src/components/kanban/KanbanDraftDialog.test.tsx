import type { KanbanPromptCard, Worktree } from "@pragma-sh/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextResolveMock } from "@/test/prompt-editor";

const createCardMock = vi.fn();
const updateCardDraftMock = vi.fn();

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({
    createCard: createCardMock,
    updateCardDraft: updateCardDraftMock,
    deleteCard: vi.fn(),
  }),
}));

vi.mock("@/plugins/agents", () => ({
  listPluginAgents: () => [{ id: "claude", name: "Claude", iconDataUrl: null, start: ["claude"] }],
}));

vi.mock("@/lib/agent-model-cache", () => ({
  cachedAgentModels: () => [],
  refreshAgentModels: async () => [],
}));

vi.mock("@/plugins/context-providers", async () => {
  const { testContextProviders } = await import("@/test/prompt-editor");
  return { useContextProviders: () => testContextProviders };
});

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

const featureWorktree: Worktree = {
  ...mainWorktree,
  id: "wt-feature",
  parentId: "main",
  branch: "feature",
  path: "/repo/.pragma/worktrees/feature",
  isMain: false,
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    selectedProjectId: "p",
    selectedWorktreeId: "main",
    activeProject: { id: "p", name: "Repo", path: "/repo" },
    worktrees: { p: [mainWorktree, featureWorktree] },
  }),
}));

import { KanbanDraftDialog } from "./KanbanDraftDialog";

const docsBlock = '<context mention="@auth-guide" source="Docs">\nAuth guide body\n</context>';

function draftCard(prompt: string): KanbanPromptCard {
  return {
    id: "card-1",
    projectId: "p",
    branchName: "feature",
    prompt,
    agentId: "claude",
    status: "draft",
    schedulingMode: "manual",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
  };
}

describe("KanbanDraftDialog @ context", () => {
  beforeEach(() => {
    contextResolveMock.mockResolvedValue("Auth guide body");
    createCardMock.mockResolvedValue(undefined);
    updateCardDraftMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("stores picked context with the draft, searching the draft branch's worktree", async () => {
    render(<KanbanDraftDialog open onOpenChange={vi.fn()} card={draftCard("")} />);
    const prompt = screen.getByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "read @au" } });
    await screen.findByRole("region", { name: "Docs" });
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(prompt).toHaveValue("read @auth-guide ");
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => expect(updateCardDraftMock).toHaveBeenCalled());
    expect(updateCardDraftMock.mock.calls[0]![1]).toMatchObject({
      prompt: `read @auth-guide\n\n${docsBlock}`,
    });
    expect(contextResolveMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: expect.objectContaining({ id: "wt-feature" }) }),
    );
  });

  it("edits a saved draft without showing its context, and keeps it on save", async () => {
    render(
      <KanbanDraftDialog
        open
        onOpenChange={vi.fn()}
        card={draftCard(`read @auth-guide\n\n${docsBlock}`)}
      />,
    );
    const prompt = screen.getByLabelText("Prompt");
    await waitFor(() => expect(prompt).toHaveValue("read @auth-guide"));
    fireEvent.change(prompt, { target: { value: "read @auth-guide carefully" } });
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));

    await waitFor(() => expect(updateCardDraftMock).toHaveBeenCalled());
    expect(updateCardDraftMock.mock.calls[0]![1]).toMatchObject({
      prompt: `read @auth-guide carefully\n\n${docsBlock}`,
    });
    expect(contextResolveMock).not.toHaveBeenCalled();
  });
});
