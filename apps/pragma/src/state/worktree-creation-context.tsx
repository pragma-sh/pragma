import {
  createContext,
  useCallback,
  useContext,
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
  branch: string;
  steps: WorktreeCreationStep[];
  error: string | null;
  retry: { request: WorktreeCreationRequest; worktree: Worktree } | null;
}

interface WorktreeCreationContextValue {
  /** Non-null while a creation is running or has failed. */
  creation: WorktreeCreationState | null;
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

  const openCreatedWorktree = useCallback(
    async (request: WorktreeCreationRequest, worktree: Worktree) => {
      // This refresh intentionally skips state writes after a project switch.
      // Pass the owner explicitly so terminal/session creation still routes to
      // the project that created this worktree.
      await workspace.refreshProject(request.projectId);
      const options = { projectId: request.projectId };
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
      workspace.selectWorktree(worktree.id, request.projectId);
      const tab = await workspace.createTerminalTab(worktree.id, options);
      if (!tab) {
        throw new Error("Couldn't open a terminal tab for the new worktree.");
      }
    },
    [workspace],
  );

  const run = useCallback(
    async (request: WorktreeCreationRequest) => {
      const steps = [
        ...(request.syncWorktreeId ? [step("sync", "active")] : []),
        step("create", request.syncWorktreeId ? "pending" : "active"),
      ];
      setCreation({ branch: request.branch, steps, error: null, retry: null });
      // The setup scripts run inside `create_worktree`, so their stage only
      // becomes visible through the backend event.
      const unlisten = await onWorktreeCreateStage((stage) => {
        if (stage.projectId !== request.projectId || stage.stage !== "scripts") return;
        setCreation((current) =>
          current
            ? activate(
                { ...current, steps: [...current.steps, step("scripts", "pending")] },
                "scripts",
              )
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
          await openCreatedWorktree(request, worktree);
          setCreation(null);
        } catch (cause) {
          setCreation((current) =>
            current
              ? {
                  ...current,
                  error: errorMessage(cause),
                  retry: { request, worktree },
                }
              : current,
          );
        }
      } catch (cause) {
        setCreation((current) => (current ? { ...current, error: errorMessage(cause) } : current));
      } finally {
        unlisten?.();
        runningRef.current = false;
      }
    },
    [openCreatedWorktree],
  );

  const startCreation = useCallback(
    (request: WorktreeCreationRequest) => {
      if (runningRef.current) return;
      runningRef.current = true;
      void run(request);
    },
    [run],
  );

  const dismiss = useCallback(() => setCreation(null), []);
  const retry = useCallback(() => {
    if (runningRef.current || !creation?.retry) return;
    runningRef.current = true;
    const { request, worktree } = creation.retry;
    setCreation((current) => (current ? { ...current, error: null } : current));
    void openCreatedWorktree(request, worktree)
      .then(() => setCreation(null))
      .catch((cause: unknown) => {
        setCreation((current) => (current ? { ...current, error: errorMessage(cause) } : current));
      })
      .finally(() => {
        runningRef.current = false;
      });
  }, [creation, openCreatedWorktree]);
  const value = useMemo(
    () => ({ creation, startCreation, dismiss, retry }),
    [creation, startCreation, dismiss, retry],
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
