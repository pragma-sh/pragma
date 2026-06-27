import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { toast } from "sonner";

import type { KanbanCompletedAction, KanbanPromptCard } from "@pragma/constants";

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
  listAgents,
  listKanbanCards,
  mergeWorktreeToParent,
  moveKanbanCard,
  onAgentReport,
  stageAll,
  updateKanbanCard,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

/** Which surface the workspace is showing: the normal shell or the Kanban board. */
export type WorkspaceMode = "normal" | "kanban";

/** Fields a draft card carries when created or edited. */
export interface KanbanDraftInput {
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

export function KanbanProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [mode, setMode] = useState<WorkspaceMode>("normal");
  const [backToKanbanAvailable, setBackToKanbanAvailable] = useState(false);
  const [cards, setCards] = useState<KanbanPromptCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [completing, setCompleting] = useState<Record<string, KanbanCompletedAction>>({});

  const projectId = workspace.selectedProjectId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  // Latest workspace handles, readable from stable callbacks without re-creating
  // them on every workspace state change.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

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

  // Load cards whenever the selected project changes (and clear on no project).
  useEffect(() => {
    if (!projectId) {
      setCards([]);
      return;
    }
    void reload();
  }, [projectId, reload]);

  // Load the configured agents once for card display and launch.
  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) {
          setAgents(Array.isArray(items) ? items : []);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync agent completion into the board: a `done` report for an in-progress
  // card's agent tab moves that card to Review needed. Always mounted, so this
  // fires whether or not the board is the visible surface. (Attention/running
  // are surfaced live per card via the agent-status store; only the terminal
  // `done` transition mutates a card.)
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onAgentReport((payload) => {
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
  }, [reload]);

  const openBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);

  const exitBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("normal");
  }, []);

  const returnToKanban = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);

  const createCard = useCallback(
    async (input: KanbanDraftInput) => {
      const target = projectIdRef.current;
      if (!target) {
        return;
      }
      await createKanbanCard(target, input.branchName, input.prompt, input.agentId, input.modelId);
      await reload();
    },
    [reload],
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
    [reload],
  );

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
      const existing = projectWorktrees.find((worktree) => worktree.branch === card.branchName);
      let worktree = existing ?? null;
      if (!worktree) {
        const parent =
          projectWorktrees.find((item) => item.isMain) ??
          projectWorktrees.find((item) => item.parentId === null) ??
          projectWorktrees[0];
        if (!parent) {
          throw new Error("No parent worktree to branch from");
        }
        worktree = await createWorktree(target, parent.id, card.branchName);
      }
      const tab = await createTabCommand(
        target,
        worktree.id,
        "terminal",
        defaultTabTitle("terminal"),
      );
      // Load the new worktree + tab into workspace state so opening the card
      // later attaches to the (now persisted) background session.
      await ws.refreshProject(target);
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
    [agents, reload],
  );

  const runCompletion = useCallback(
    async (card: KanbanPromptCard, action: KanbanCompletedAction) => {
      const worktreeId = card.worktreeId;
      if (!worktreeId && action !== "manual") {
        throw new Error("Card has no worktree to complete");
      }
      let pullRequestUrl: string | null = card.pullRequestUrl ?? null;
      let pullRequestNumber: number | null = card.pullRequestNumber ?? null;
      if (action === "commitMerge" && worktreeId) {
        await stageAll(worktreeId);
        const message = await aiGenerateCommitMessage(worktreeId);
        await commitStaged(worktreeId, message);
        await mergeWorktreeToParent(worktreeId);
      } else if (action === "commitPr" && worktreeId) {
        const draft = await aiCommitAllAndGeneratePullRequestDraft(worktreeId);
        const repo = await githubRepoRef(worktreeId);
        await githubPushBranch(worktreeId);
        const pr = await createPullRequest(
          repo,
          { owner: repo.owner, repo: repo.repo, branch: repo.parentBranch ?? repo.defaultBranch },
          { title: draft.title, body: draft.body, draft: false },
        );
        pullRequestUrl = pr.htmlUrl;
        pullRequestNumber = pr.number;
      }
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
      void (async () => {
        try {
          let pullRequestUrl: string | null = card.pullRequestUrl ?? null;
          let pullRequestNumber: number | null = card.pullRequestNumber ?? null;
          if (action === "commitMerge") {
            await stageAll(worktreeId);
            const message = await aiGenerateCommitMessage(worktreeId);
            await commitStaged(worktreeId, message);
            await mergeWorktreeToParent(worktreeId);
          } else if (action === "commitPr") {
            const draft = await aiCommitAllAndGeneratePullRequestDraft(worktreeId);
            const repo = await githubRepoRef(worktreeId);
            await githubPushBranch(worktreeId);
            const pr = await createPullRequest(
              repo,
              {
                owner: repo.owner,
                repo: repo.repo,
                branch: repo.parentBranch ?? repo.defaultBranch,
              },
              { title: draft.title, body: draft.body, draft: false },
            );
            pullRequestUrl = pr.htmlUrl;
            pullRequestNumber = pr.number;
          }
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
          setCompleting((current) => {
            const next = { ...current };
            delete next[card.id];
            return next;
          });
          await reload();
        }
      })();
    },
    [reload],
  );

  const openCardWorktree = useCallback((card: KanbanPromptCard) => {
    const ws = workspaceRef.current;
    if (card.worktreeId) {
      ws.selectWorktree(card.worktreeId);
    }
    if (card.agentTabId) {
      ws.setActiveTab(card.agentTabId);
    }
    setBackToKanbanAvailable(true);
    setMode("normal");
  }, []);

  // A project switch invalidates a card-driven return affordance (it pointed at
  // the previous project's worktree).
  useEffect(() => {
    setBackToKanbanAvailable(false);
  }, [projectId]);

  const value = useMemo<KanbanContextValue>(
    () => ({
      mode: projectId ? mode : "normal",
      openBoard,
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
  const context = useContext(KanbanContext);
  if (!context) {
    throw new Error("useKanban must be used inside KanbanProvider");
  }
  return context;
}
