import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AutomationInfo, AutomationRootRegistration } from "@pragma/constants";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRequiredContext } from "@/lib/context";
import { errorMessage } from "@/lib/errors";
import {
  approveAutomation,
  listAutomations,
  onAutomationPending,
  onAutomationsChanged,
  registerAutomationRoots,
  rejectAutomation,
  runAutomationNow,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface AutomationsContextValue {
  automations: AutomationInfo[];
  loading: boolean;
  reload: () => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<void>;
}

const AutomationsContext = createContext<AutomationsContextValue | null>(null);

export function AutomationsProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [automations, setAutomations] = useState<AutomationInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<AutomationInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const pending = queue[0] ?? null;
  const pendingIds = useRef(new Set<string>());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAutomations(await listAutomations());
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const projects: AutomationRootRegistration[] = workspace.projects.map((project) => ({
      projectId: project.id,
      projectPath: project.path,
      worktrees: (workspace.worktrees[project.id] ?? []).map((worktree) => ({
        worktreeId: worktree.id,
        path: worktree.path,
        label: worktree.title ?? worktree.branch,
        isMain: worktree.isMain,
      })),
    }));
    void registerAutomationRoots(projects)
      .then(reload)
      .catch((cause) => {
        toast.error(errorMessage(cause));
      });
  }, [reload, workspace.projects, workspace.worktrees]);

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    void onAutomationPending((automation) => {
      if (cancelled || pendingIds.current.has(automation.id)) return;
      pendingIds.current.add(automation.id);
      setQueue((current) => [...current, automation]);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unsubs.push(unlisten);
      return undefined;
    });
    void onAutomationsChanged((items) => {
      if (!cancelled) setAutomations(items);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unsubs.push(unlisten);
      return undefined;
    });
    void reload();
    return () => {
      cancelled = true;
      for (const unlisten of unsubs) unlisten();
    };
  }, [reload]);

  const approve = useCallback(
    async (id: string) => {
      await approveAutomation(id);
      pendingIds.current.delete(id);
      setQueue((current) => current.filter((item) => item.id !== id));
      await reload();
    },
    [reload],
  );

  const reject = useCallback(
    async (id: string) => {
      await rejectAutomation(id);
      pendingIds.current.delete(id);
      setQueue((current) => current.filter((item) => item.id !== id));
      await reload();
    },
    [reload],
  );

  const runNow = useCallback(async (id: string) => {
    await runAutomationNow(id);
  }, []);

  const value = useMemo<AutomationsContextValue>(
    () => ({ automations, loading, reload, approve, reject, runNow }),
    [automations, loading, reload, approve, reject, runNow],
  );

  async function respond(action: "approve" | "reject") {
    if (!pending) return;
    setSubmitting(true);
    try {
      if (action === "approve") await approve(pending.id);
      else await reject(pending.id);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AutomationsContext.Provider value={value}>
      {children}
      <AlertDialog open={pending !== null}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Trust local automation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.name ?? "This automation"} wants to run background code on this host.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <div className="font-medium text-foreground">{pending?.name}</div>
              <div className="text-muted-foreground">{pending?.description}</div>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              This code can run on your machine on a schedule or in response to events, even when
              Pragma is closed. Trust only files from sources you control.
            </div>
            <div className="break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
              {pending?.path}
            </div>
          </div>
          <AlertDialogFooter>
            <Button disabled={submitting} variant="ghost" onClick={() => void respond("reject")}>
              Reject
            </Button>
            <Button disabled={submitting} onClick={() => void respond("approve")}>
              Trust and install
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AutomationsContext.Provider>
  );
}

/** Accesses host automation state and actions. */
export function useAutomations(): AutomationsContextValue {
  return useRequiredContext(AutomationsContext, "useAutomations");
}
