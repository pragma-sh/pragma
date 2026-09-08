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

import { errorMessage } from "@/lib/errors";
import {
  createWorktree,
  githubPullBranch,
  onWorktreeCreateStage,
  type AgentConfig,
  type AgentModelSelection,
} from "@/lib/tauri";
import { expandWorktree } from "@/state/worktree-collapsed";
import { useWorkspace } from "@/state/workspace-context";
import type { Worktree } from "@pragma/constants";

/** The stages a create-worktree run can move through, in display order. */
export type WorktreeCreationStepId = "sync" | "create" | "scripts";

/** One row in the loading screen's step list. */
export interface WorktreeCreationStep {
  id: WorktreeCreationStepId;
  label: string;
  status: "pending" | "active" | "done";
}

/** Everything the flow needs once the dialog has collected all user input. */
interface WorktreeCreationRequest {
  projectId: string;
  parentWorktreeId: string;
  branch: string;
  title?: string;
  /** Markdown prompt; when empty no agent session is started. */
  prompt?: string;
  agent?: AgentConfig | null;
  modelSelection?: AgentModelSelection;
  /** Worktree to pull before creating (the "Sync and create" choice). */
  syncWorktreeId?: string | null;
}

/** Live progress for the full-frame creating-worktree screen. */
interface WorktreeCreationState {
  projectId: string;
  /** Worktree the pending one hangs under, so the sidebar can place its row. */
  parentWorktreeId: string;
  branch: string;
  /** Row label for the optimistic sidebar row (the branch when untitled). */
  label: string;
  steps: WorktreeCreationStep[];
  error: string | null;
  retry: { request: WorktreeCreationRequest; worktree: Worktree } | null;
  /** Whether the progress screen currently occupies the workspace frame. */
  viewing: boolean;
  /** Workspace selection the screen was opened from; changing it leaves the
   *  screen, so a creation can run in the background. */
  viewedFrom: string;
}

interface WorktreeCreationContextValue {
  /** Non-null while a creation is running or has failed. */
  creation: WorktreeCreationState | null;
  /** Re-opens the progress screen (from the optimistic sidebar row). */
  viewCreation: () => void;
  /** Starts a creation in the background — the caller closes its dialog immediately. */
  startCreation: (request: WorktreeCreationRequest) => void;
  /** Clears a failed run's screen. */
  dismiss: () => void;
  /** Retries opening a worktree after terminal/session launch fails. */
  retry: () => void;
}

const STEP_LABELS: Record<WorktreeCreationStepId, string> = {
  sync: "Syncing base",
  create: "Creating worktree",
  scripts: "Running scripts",
};

const WorktreeCreationContext = createContext<WorktreeCreationContextValue | null>(null);

function step(id: WorktreeCreationStepId, status: WorktreeCreationStep["status"]) {
  return { id, label: STEP_LABELS[id], status };
}

/** Marks `id` active and every earlier step done. */
function activate(state: WorktreeCreationState, id: WorktreeCreationStepId): WorktreeCreationState {
  const index = state.steps.findIndex((entry) => entry.id === id);
  if (index < 0) return state;
  return {
    ...state,
    steps: state.steps.map((entry, position) =>
      position < index
        ? { ...entry, status: "done" }
        : position === index
          ? { ...entry, status: "active" }
          : entry,
    ),
  };
}

interface RunCreationDeps {
  setCreation: (
    updater:
      | WorktreeCreationState
      | null
      | ((current: WorktreeCreationState | null) => WorktreeCreationState | null),
  ) => void;
  /** Mirrors `creation.viewing`; read at completion time to decide whether
   *  opening the new worktree may take the foreground. */
  viewingRef: { current: boolean };
  selectionRef: { current: string };
  openCreatedWorktree: (
    request: WorktreeCreationRequest,
    worktree: Worktree,
    focus: boolean,
  ) => Promise<void>;
}

/**
 * Runs one create-worktree flow end to end: seeds the progress state, tracks
 * backend stage events, creates the worktree (with an optional base sync
 * first), and hands off to `openCreatedWorktree`. Split out of the provider
 * component so the component itself stays a thin set of callbacks.
 */
async function runWorktreeCreation(
  request: WorktreeCreationRequest,
  { setCreation, viewingRef, selectionRef, openCreatedWorktree }: RunCreationDeps,
): Promise<void> {
  const steps = [
    ...(request.syncWorktreeId ? [step("sync", "active")] : []),
    step("create", request.syncWorktreeId ? "pending" : "active"),
  ];
  viewingRef.current = true;
  setCreation({
    projectId: request.projectId,
    parentWorktreeId: request.parentWorktreeId,
    branch: request.branch,
    label: request.title?.trim() || request.branch,
    steps,
    error: null,
    retry: null,
    viewing: true,
    viewedFrom: selectionRef.current,
  });
  // The optimistic row hangs under its parent, which has to be open for it to
  // be visible at all.
  expandWorktree(request.parentWorktreeId);
  // The setup scripts run inside `create_worktree`, so their stage only
  // becomes visible through the backend event.
  const unlisten = await onWorktreeCreateStage((stage) => {
    if (stage.projectId !== request.projectId || stage.stage !== "scripts") return;
    setCreation((current) =>
      current
        ? activate({ ...current, steps: [...current.steps, step("scripts", "pending")] }, "scripts")
        : current,
    );
  }).catch(() => null);
  try {
    if (request.syncWorktreeId) {
      await githubPullBranch(request.syncWorktreeId);
      setCreation((current) => (current ? activate(current, "create") : current));
    }
    const worktree = await createWorktree(
      request.projectId,
      request.parentWorktreeId,
      request.branch,
      request.title,
    );
    setCreation((current) =>
      current
        ? { ...current, steps: current.steps.map((entry) => ({ ...entry, status: "done" })) }
        : current,
    );
    try {
      await openCreatedWorktree(request, worktree, viewingRef.current);
      setCreation(null);
    } catch (cause) {
      setCreation((current) =>
        current
          ? { ...current, error: errorMessage(cause), retry: { request, worktree } }
          : current,
      );
    }
  } catch (cause) {
    setCreation((current) => (current ? { ...current, error: errorMessage(cause) } : current));
  } finally {
    unlisten?.();
  }
}

/**
 * Owns the background create-worktree flow so the dialog can close as soon as
 * the user has answered everything, and the shell can show a full-frame
 * progress screen instead of a blocking modal.
 */
export function WorktreeCreationProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [creation, setCreation] = useState<WorktreeCreationState | null>(null);
  // A ref so a second submit while one is in flight is ignored without the
  // callback closing over a stale `creation`.
  const runningRef = useRef(false);
  // Mirrors `creation.viewing` so `runWorktreeCreation` can decide, at
  // completion time, whether the user is still on the progress screen without
  // closing over a stale `creation` — kept in sync with every state update
  // that changes `viewing`.
  const viewingRef = useRef(false);
  // Identity of the current workspace selection. The progress screen is tied to
  // the selection it was opened from: picking another worktree, tab, or project
  // leaves it while the creation keeps running in the background. The project id
  // is included so switching to a different project that happens to have the
  // same selected-worktree/active-tab identifiers (e.g. both on `main` with no
  // active tab) still counts as leaving.
  const selectionKey = `${workspace.selectedProjectId ?? ""}|${workspace.selectedWorktreeId ?? ""}|${workspace.activeTabId ?? ""}`;
  const selectionRef = useRef(selectionKey);
  useEffect(() => {
    selectionRef.current = selectionKey;
    setCreation((current) => {
      if (!current || !current.viewing || current.viewedFrom === selectionKey) return current;
      viewingRef.current = false;
      return { ...current, viewing: false };
    });
  }, [selectionKey]);

  const openCreatedWorktree = useCallback(
    async (request: WorktreeCreationRequest, worktree: Worktree, focus: boolean) => {
      // This refresh intentionally skips state writes after a project switch.
      // Pass the owner explicitly so terminal/session creation still routes to
      // the project that created this worktree.
      await workspace.refreshProject(request.projectId);
      // `focus: false` when the user has left for other work in the meantime,
      // so a background completion opens the terminal/agent tab without
      // pulling them away from what they're doing now.
      const options = { projectId: request.projectId, focus };
      const prompt = request.prompt?.trim();
      if (prompt && request.agent) {
        const tab = await workspace.startSession(
          worktree.id,
          request.agent,
          prompt,
          request.modelSelection,
          options,
        );
        if (!tab) {
          throw new Error("Couldn't start an agent session for the new worktree.");
        }
        return;
      }
      if (focus) {
        workspace.selectWorktree(worktree.id, request.projectId);
      }
      const tab = await workspace.createTerminalTab(worktree.id, options);
      if (!tab) {
        throw new Error("Couldn't open a terminal tab for the new worktree.");
      }
    },
    [workspace],
  );

  const startCreation = useCallback(
    (request: WorktreeCreationRequest) => {
      if (runningRef.current) return;
      runningRef.current = true;
      void runWorktreeCreation(request, {
        setCreation,
        viewingRef,
        selectionRef,
        openCreatedWorktree,
      }).finally(() => {
        runningRef.current = false;
      });
    },
    [openCreatedWorktree],
  );

  const viewCreation = useCallback(() => {
    viewingRef.current = true;
    setCreation((current) =>
      current ? { ...current, viewing: true, viewedFrom: selectionRef.current } : current,
    );
  }, []);
  const dismiss = useCallback(() => setCreation(null), []);
  const retry = useCallback(() => {
    if (runningRef.current || !creation?.retry) return;
    runningRef.current = true;
    viewingRef.current = true;
    const { request, worktree } = creation.retry;
    setCreation((current) =>
      current
        ? { ...current, error: null, viewing: true, viewedFrom: selectionRef.current }
        : current,
    );
    void openCreatedWorktree(request, worktree, true)
      .then(() => setCreation(null))
      .catch((cause: unknown) => {
        setCreation((current) => (current ? { ...current, error: errorMessage(cause) } : current));
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, [creation, openCreatedWorktree]);
  const value = useMemo(
    () => ({ creation, startCreation, viewCreation, dismiss, retry }),
    [creation, startCreation, viewCreation, dismiss, retry],
  );

  return <WorktreeCreationContext value={value}>{children}</WorktreeCreationContext>;
}

/** Access to the background create-worktree flow and its progress. */
export function useWorktreeCreation(): WorktreeCreationContextValue {
  const value = useContext(WorktreeCreationContext);
  if (!value) {
    throw new Error("useWorktreeCreation must be used within a WorktreeCreationProvider");
  }
  return value;
}
