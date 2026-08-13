import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useRequiredContext } from "@/lib/context";

import { toast } from "sonner";

import type {
  AgentReportPayload,
  KanbanCompletedAction,
  KanbanPromptCard,
  Worktree,
} from "@pragma/constants";

import { useAgentsList } from "@/hooks/use-agents-list";
import { startBackgroundAgentSession } from "@/lib/agent-launch";
import { createPullRequest } from "@/lib/github";
import { defaultTabTitle } from "@/lib/tab-title";
import {
  type AgentConfig,
  aiCommitAllAndGeneratePullRequestDraft,
  aiGenerateCommitMessage,
  commitStaged,
  createKanbanCard,
  createTab as createTabCommand,
  createWorktree,
  deleteKanbanCard,
  githubPushBranch,
  githubRepoRef,
  listKanbanCards,
  mergeWorktreeToParent,
  moveKanbanCard,
  onAgentReport,
  stageAll,
  updateKanbanCard,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

/** Which surface the workspace is showing: normal shell, Kanban board, or settings. */
type WorkspaceMode = "normal" | "kanban" | "settings";

/** Fields a draft card carries when created or edited. */
interface KanbanDraftInput {
  branchName: string;
  prompt: string;
  agentId: string;
  modelId: string | null;
}

interface KanbanContextValue {
  /** Whether the Kanban board or the normal workspace shell is visible. */
  mode: WorkspaceMode;
  /** Opens the board for the selected project (clears any return affordance). */
  openBoard: () => void;
  /** Opens the full-frame Settings workspace, optionally at a given section. */
  openSettings: (section?: string) => void;
  /** Leaves Settings for the surface that opened it. */
  closeSettings: () => void;
  /** Section Settings should open at, set by the last `openSettings` call. */
  settingsSection: string | null;
  /** Exits the board to the normal shell without leaving a return affordance. */
  exitBoard: () => void;
  /** Returns to the board (the "Back to Kanban" control). */
  returnToKanban: () => void;
  /** True when a card-driven navigation left a "Back to Kanban" affordance up. */
  backToKanbanAvailable: boolean;
  /** Cards for the selected project. */
  cards: KanbanPromptCard[];
  loading: boolean;
  /** Configured agents, for resolving a card's agent name/config. */
  agents: AgentConfig[];
  /** Reloads the selected project's cards from SQLite. */
  reload: () => Promise<void>;
  createCard: (input: KanbanDraftInput) => Promise<void>;
  updateCardDraft: (card: KanbanPromptCard, input: KanbanDraftInput) => Promise<void>;
  /**
   * Removes a card. Drafts are card-only; every started card (in progress,
   * review, completed) also tears down its worktree with `force` — callers are
   * expected to confirm and warn about unmerged work first. `deleteBranch` also
   * removes the card's local branch (ignored for drafts, which own no worktree).
   */
  deleteCard: (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => Promise<void>;
  /** draft -> inProgress: create/reuse a worktree, launch the agent in a background tab. */
  startCard: (card: KanbanPromptCard) => Promise<void>;
  /** reviewNeeded -> completed via the chosen completion path. */
  runCompletion: (
    card: KanbanPromptCard,
    action: KanbanCompletedAction,
  ) => Promise<KanbanPromptCard>;
  /**
   * reviewNeeded -> completed as a background job: moves the card to Completed
   * immediately, then runs the commit/merge or commit/PR work without blocking.
   * The card id is held in {@link completing} (mapped to its action) for the
   * card's loading badge until the job finishes with a success/error toast. On
   * failure the card is moved back to Review needed.
   */
  completeCard: (card: KanbanPromptCard, action: KanbanCompletedAction) => Promise<void>;
  /** Cards running a background completion right now, keyed by id → its action. */
  completing: Record<string, KanbanCompletedAction>;
  /** Navigates the normal shell to a card's worktree/tab and shows Back to Kanban. */
  openCardWorktree: (card: KanbanPromptCard) => void;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

function nowIso(): string {
  return new Date().toISOString();
}

/** Picks an existing worktree on the card's branch, or branches a fresh one off the project main. */
async function resolveStartCardWorktree(
  projectWorktrees: Worktree[],
  card: KanbanPromptCard,
  target: string,
): Promise<Worktree> {
  const existing = projectWorktrees.find((worktree) => worktree.branch === card.branchName);
  if (existing) {
    return existing;
  }
  const parent =
    projectWorktrees.find((item) => item.isMain) ??
    projectWorktrees.find((item) => item.parentId === null) ??
    projectWorktrees[0];
  if (!parent) {
    throw new Error("No parent worktree to branch from");
  }
  return createWorktree(target, parent.id, card.branchName);
}

/** Runs the git/AI/GitHub steps for a completion action, returning any PR reference it produced. */
async function applyCompletionAction(
  action: KanbanCompletedAction,
  worktreeId: string | undefined,
  card: KanbanPromptCard,
): Promise<{ pullRequestUrl: string | null; pullRequestNumber: number | null }> {
  if (action === "commitMerge" && worktreeId) {
    await stageAll(worktreeId);
    const message = await aiGenerateCommitMessage(worktreeId);
    await commitStaged(worktreeId, message);
    await mergeWorktreeToParent(worktreeId);
    return { pullRequestUrl: null, pullRequestNumber: null };
  }
  if (action === "commitPr" && worktreeId) {
    const draft = await aiCommitAllAndGeneratePullRequestDraft(worktreeId);
    const repo = await githubRepoRef(worktreeId);
    await githubPushBranch(worktreeId);
    const pr = await createPullRequest(
      repo,
      { owner: repo.owner, repo: repo.repo, branch: repo.parentBranch ?? repo.defaultBranch },
      { title: draft.title, body: draft.body, draft: false, worktreeId },
    );
    return { pullRequestUrl: pr.htmlUrl, pullRequestNumber: pr.number };
  }
  return {
    pullRequestUrl: card.pullRequestUrl ?? null,
    pullRequestNumber: card.pullRequestNumber ?? null,
  };
}

/** Background completion: runs the action, persists the result, and restores the card on failure. */
async function runCompletionInBackground(
  card: KanbanPromptCard,
  action: KanbanCompletedAction,
  worktreeId: string,
  reload: () => Promise<void>,
): Promise<void> {
  try {
    const { pullRequestUrl, pullRequestNumber } = await applyCompletionAction(
      action,
      worktreeId,
      card,
    );
    await updateKanbanCard({
      ...card,
      status: "completed",
      completedAction: action,
      completedAt: card.completedAt ?? nowIso(),
      pullRequestUrl,
      pullRequestNumber,
    });
    toast.success(action === "commitMerge" ? "Merge complete" : "Pull request filed");
  } catch (cause) {
    // The job failed — return the card to Review needed so it can be retried.
    await updateKanbanCard({
      ...card,
      status: "reviewNeeded",
      completedAction: null,
      completedAt: null,
    });
    toast.error(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await reload();
  }
}

/** Moves an in-progress card to Review needed when its agent tab reports `done`. */
function moveInProgressCardToReview(
  payload: AgentReportPayload,
  cardsRef: RefObject<KanbanPromptCard[]>,
  reload: () => Promise<void>,
): void {
  if (payload.status !== "done") {
    return;
  }
  const card = cardsRef.current.find(
    (item) => item.agentTabId === payload.tabId && item.status === "inProgress",
  );
  if (!card) {
    return;
  }
  void moveKanbanCard(card.id, "reviewNeeded").then(() => reload());
}

/** Loads and clears cards as the selected project changes. */
function useKanbanCards(projectId: string | null): {
  cards: KanbanPromptCard[];
  loading: boolean;
  reload: () => Promise<void>;
  cardsRef: RefObject<KanbanPromptCard[]>;
} {
  const [cards, setCards] = useState<KanbanPromptCard[]>([]);
  const [loading, setLoading] = useState(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const reload = useCallback(async () => {
    const target = projectIdRef.current;
    if (!target) {
      setCards([]);
      return;
    }
    setLoading(true);
    try {
      const loaded = await listKanbanCards(target);
      // Guard against a slow load landing after the user switched projects.
      if (projectIdRef.current === target) {
        setCards(loaded);
      }
    } finally {
      if (projectIdRef.current === target) {
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!projectId) {
      setCards([]);
      return;
    }
    void reload();
  }, [projectId, reload]);
  return { cards, loading, reload, cardsRef };
}

/** Moves in-progress cards to Review needed as their agent tabs report `done`. */
function useKanbanCompletionSync(
  cardsRef: RefObject<KanbanPromptCard[]>,
  reload: () => Promise<void>,
): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onAgentReport((payload) => {
      moveInProgressCardToReview(payload, cardsRef, reload);
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return undefined;
        }
        unlisten = stop;
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [cardsRef, reload]);
}

/** Draft mutations: create, edit, and delete cards (and their worktrees). */
function useKanbanCardDrafts(
  workspaceRef: RefObject<ReturnType<typeof useWorkspace>>,
  projectIdRef: RefObject<string | null>,
  reload: () => Promise<void>,
): {
  createCard: (input: KanbanDraftInput) => Promise<void>;
  updateCardDraft: (card: KanbanPromptCard, input: KanbanDraftInput) => Promise<void>;
  deleteCard: (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => Promise<void>;
} {
  const createCard = useCallback(
    async (input: KanbanDraftInput) => {
      const target = projectIdRef.current;
      if (!target) {
        return;
      }
      await createKanbanCard(target, input.branchName, input.prompt, input.agentId, input.modelId);
      await reload();
    },
    [projectIdRef, reload],
  );
  const updateCardDraft = useCallback(
    async (card: KanbanPromptCard, input: KanbanDraftInput) => {
      await updateKanbanCard({
        ...card,
        branchName: input.branchName,
        prompt: input.prompt,
        agentId: input.agentId,
        modelId: input.modelId,
      });
      await reload();
    },
    [reload],
  );
  const deleteCard = useCallback(
    async (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => {
      // A started card owns a worktree; remove it from disk first (force, since
      // the delete flow already confirms and warns about unmerged work), optionally
      // taking its local branch too. Drafts have no worktree and are simply dropped.
      if (card.status !== "draft" && card.worktreeId) {
        await workspaceRef.current.deleteWorktree(card.worktreeId, {
          deleteBranch: options?.deleteBranch ?? false,
          force: true,
        });
      }
      await deleteKanbanCard(card.id);
      await reload();
    },
    [workspaceRef, reload],
  );
  return { createCard, updateCardDraft, deleteCard };
}

/** Card lifecycle: start a card, run completion inline, complete in background, or open its worktree. */
function useKanbanCardLifecycle(
  workspaceRef: RefObject<ReturnType<typeof useWorkspace>>,
  agents: AgentConfig[],
  reload: () => Promise<void>,
  setCompleting: (
    updater: (
      current: Record<string, KanbanCompletedAction>,
    ) => Record<string, KanbanCompletedAction>,
  ) => void,
  setBackToKanbanAvailable: (value: boolean) => void,
  setMode: (mode: WorkspaceMode) => void,
): {
  startCard: (card: KanbanPromptCard) => Promise<void>;
  runCompletion: (
    card: KanbanPromptCard,
    action: KanbanCompletedAction,
  ) => Promise<KanbanPromptCard>;
  completeCard: (card: KanbanPromptCard, action: KanbanCompletedAction) => Promise<void>;
  openCardWorktree: (card: KanbanPromptCard) => void;
} {
  const startCard = useCallback(
    async (card: KanbanPromptCard) => {
      const target = card.projectId;
      const agent = agents.find((item) => item.id === card.agentId) ?? agents[0];
      if (!agent) {
        throw new Error("No agent configured to start this card");
      }
      const ws = workspaceRef.current;
      const projectWorktrees = ws.worktrees[target] ?? [];
      // Reuse an existing worktree on the same branch; otherwise branch a fresh
      // one off the project's main worktree.
      const worktree = await resolveStartCardWorktree(projectWorktrees, card, target);
      const tab = await createTabCommand(
        target,
        worktree.id,
        "terminal",
        defaultTabTitle("terminal"),
      );
      // Load the new worktree + tab into workspace state so opening the card
      // later attaches to the (now persisted) background session.
      await ws.refreshProject(target);
      await ws.markTabAgent(tab.id, agent);
      await startBackgroundAgentSession(tab.id, worktree.id, worktree.path, agent, card.prompt, {
        modelId: card.modelId ?? null,
        reasoningId: null,
      });
      await updateKanbanCard({
        ...card,
        status: "inProgress",
        worktreeId: worktree.id,
        agentTabId: tab.id,
        startedAt: nowIso(),
      });
      await reload();
    },
    [agents, reload, workspaceRef],
  );

  const runCompletion = useCallback(
    async (card: KanbanPromptCard, action: KanbanCompletedAction) => {
      const worktreeId = card.worktreeId;
      if (!worktreeId && action !== "manual") {
        throw new Error("Card has no worktree to complete");
      }
      const { pullRequestUrl, pullRequestNumber } = await applyCompletionAction(
        action,
        worktreeId ?? undefined,
        card,
      );
      const saved = await updateKanbanCard({
        ...card,
        status: "completed",
        completedAction: action,
        pullRequestUrl,
        pullRequestNumber,
        completedAt: nowIso(),
      });
      await reload();
      return saved;
    },
    [reload],
  );

  const completeCard = useCallback(
    async (card: KanbanPromptCard, action: KanbanCompletedAction) => {
      const worktreeId = card.worktreeId;
      if (!worktreeId) {
        toast.error("Card has no worktree to complete");
        return;
      }
      // Optimistically move the card into Completed and flag it as running so the
      // card shows a "Merging…" / "Opening PR…" badge while the work happens.
      await updateKanbanCard({
        ...card,
        status: "completed",
        completedAction: action,
        completedAt: nowIso(),
      });
      setCompleting((current) => ({ ...current, [card.id]: action }));
      await reload();
      // Run the heavy git/AI/GitHub work in the background, off the caller's await.
      void runCompletionInBackground(card, action, worktreeId, reload).finally(() => {
        setCompleting((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
      });
    },
    [reload, setCompleting],
  );

  const openCardWorktree = useCallback(
    (card: KanbanPromptCard) => {
      const ws = workspaceRef.current;
      if (card.worktreeId) {
        ws.selectWorktree(card.worktreeId);
      }
      if (card.agentTabId) {
        ws.setActiveTab(card.agentTabId);
      }
      setBackToKanbanAvailable(true);
      setMode("normal");
    },
    [workspaceRef, setBackToKanbanAvailable, setMode],
  );

  return { startCard, runCompletion, completeCard, openCardWorktree };
}

/** Board surface mode (normal shell vs Kanban) and the return-to-board affordance. */
function useKanbanBoardMode(projectId: string | null): {
  mode: WorkspaceMode;
  backToKanbanAvailable: boolean;
  openBoard: () => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  settingsSection: string | null;
  exitBoard: () => void;
  returnToKanban: () => void;
  setBackToKanbanAvailable: (value: boolean) => void;
  setMode: (mode: WorkspaceMode) => void;
} {
  const [mode, setMode] = useState<WorkspaceMode>("normal");
  const [backToKanbanAvailable, setBackToKanbanAvailable] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const settingsReturnMode = useRef<Exclude<WorkspaceMode, "settings">>("normal");
  const openBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);
  const openSettings = useCallback((section?: string) => {
    setBackToKanbanAvailable(false);
    setSettingsSection(section ?? null);
    setMode((current) => {
      if (current !== "settings") settingsReturnMode.current = current;
      return "settings";
    });
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsSection(null);
    setMode(settingsReturnMode.current);
  }, []);
  const exitBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("normal");
  }, []);
  const returnToKanban = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);
  // A project switch invalidates a card-driven return affordance (it pointed at
  // the previous project's worktree).
  useEffect(() => {
    setBackToKanbanAvailable(false);
  }, [projectId]);
  return {
    mode,
    backToKanbanAvailable,
    openBoard,
    openSettings,
    closeSettings,
    settingsSection,
    exitBoard,
    returnToKanban,
    setBackToKanbanAvailable,
    setMode,
  };
}

export function KanbanProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [completing, setCompleting] = useState<Record<string, KanbanCompletedAction>>({});

  const projectId = workspace.selectedProjectId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Latest workspace handles, readable from stable callbacks without re-creating
  // them on every workspace state change.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const {
    mode,
    backToKanbanAvailable,
    openBoard,
    openSettings,
    closeSettings,
    settingsSection,
    exitBoard,
    returnToKanban,
    setBackToKanbanAvailable,
    setMode,
  } = useKanbanBoardMode(projectId);
  const agents = useAgentsList();
  const { cards, loading, reload, cardsRef } = useKanbanCards(projectId);
  useKanbanCompletionSync(cardsRef, reload);
  const { createCard, updateCardDraft, deleteCard } = useKanbanCardDrafts(
    workspaceRef,
    projectIdRef,
    reload,
  );
  const { startCard, runCompletion, completeCard, openCardWorktree } = useKanbanCardLifecycle(
    workspaceRef,
    agents,
    reload,
    setCompleting,
    setBackToKanbanAvailable,
    setMode,
  );

  const value = useMemo<KanbanContextValue>(
    () => ({
      mode: projectId || mode === "settings" ? mode : "normal",
      openBoard,
      openSettings,
      closeSettings,
      settingsSection,
      exitBoard,
      returnToKanban,
      backToKanbanAvailable,
      cards,
      loading,
      agents,
      reload,
      createCard,
      updateCardDraft,
      deleteCard,
      startCard,
      runCompletion,
      completeCard,
      completing,
      openCardWorktree,
    }),
    [
      projectId,
      mode,
      openBoard,
      openSettings,
      closeSettings,
      settingsSection,
      exitBoard,
      returnToKanban,
      backToKanbanAvailable,
      cards,
      loading,
      agents,
      reload,
      createCard,
      updateCardDraft,
      deleteCard,
      startCard,
      runCompletion,
      completeCard,
      completing,
      openCardWorktree,
    ],
  );

  return <KanbanContext.Provider value={value}>{children}</KanbanContext.Provider>;
}

/** Accesses the project Kanban board state and actions. */
export function useKanban(): KanbanContextValue {
  return useRequiredContext(KanbanContext, "useKanban");
}
