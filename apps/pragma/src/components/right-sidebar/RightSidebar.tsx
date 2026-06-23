import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { Loader2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";

import { ChangesTab } from "@/components/right-sidebar/ChangesTab";
import { FilesTab } from "@/components/right-sidebar/FilesTab";
import { PullRequestTab } from "@/components/right-sidebar/PullRequestTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  aiCommitAllAndGeneratePullRequestDraft,
  type AiPullRequestDraft,
  worktreeChanges,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { type RightSidebarSubtab, useRightSidebar } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const COMMIT_PR_REFRESH_INTERVAL_MS = 2000;

/**
 * Secondary sidebar on the right edge of the workspace, mirroring the left
 * `ProjectSidebar`. Collapses to a thin strip and hosts the Files and Changes
 * subtabs. Rendered as the last flex child of the workspace so the center pane
 * reflows when it collapses (the BrowserView ResizeObserver re-applies native
 * webview bounds automatically).
 */
export function RightSidebar() {
  const { collapsed, activeSubtab, width, toggleCollapsed, setActiveSubtab, setWidth } =
    useRightSidebar();
  const workspace = useWorkspace();
  const { available: aiAvailable } = useAi();
  // Commit & PR jobs run in the Rust backend and survive a worktree switch, so
  // we track them per worktree id rather than with a single boolean. That keeps
  // the spinner on the worktree it belongs to and lets a job keep running (and
  // land its draft) while the user works in a different worktree.
  const [runningWorktrees, setRunningWorktrees] = useState<ReadonlySet<string>>(new Set());
  const [generatedPrDrafts, setGeneratedPrDrafts] = useState<
    Record<string, { key: number; draft: AiPullRequestDraft }>
  >({});
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const availabilityWorktree = useRef<string | null>(null);

  const selectedWorktreeId = workspace.selectedWorktreeId;
  const commitPrRunning = selectedWorktreeId ? runningWorktrees.has(selectedWorktreeId) : false;
  const generatedPrDraft = selectedWorktreeId ? generatedPrDrafts[selectedWorktreeId] : undefined;

  const refreshCommitPrAvailability = useCallback(async () => {
    const worktreeId = workspace.selectedWorktreeId;
    // Skip the IPC + git work entirely when AI is unavailable — the Commit & PR
    // button is hidden then, so the answer is never used.
    if (!worktreeId || !aiAvailable) {
      setHasUncommittedChanges(false);
      return;
    }
    try {
      const changes = await worktreeChanges(worktreeId);
      if (availabilityWorktree.current === worktreeId) {
        setHasUncommittedChanges(changes.staged.length > 0 || changes.unstaged.length > 0);
      }
    } catch {
      if (availabilityWorktree.current === worktreeId) {
        setHasUncommittedChanges(false);
      }
    }
  }, [workspace.selectedWorktreeId, aiAvailable]);

  useEffect(() => {
    availabilityWorktree.current = workspace.selectedWorktreeId;
    setHasUncommittedChanges(false);
    if (!aiAvailable) {
      return;
    }
    void refreshCommitPrAvailability();
    const interval = setInterval(
      () => void refreshCommitPrAvailability(),
      COMMIT_PR_REFRESH_INTERVAL_MS,
    );
    const onFocus = () => void refreshCommitPrAvailability();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [workspace.selectedWorktreeId, aiAvailable, refreshCommitPrAvailability]);

  const runCommitAndPr = useCallback(async () => {
    const worktreeId = workspace.selectedWorktreeId;
    if (!worktreeId || runningWorktrees.has(worktreeId) || !hasUncommittedChanges) {
      return;
    }
    if (!aiAvailable) {
      toast.error("Connect an AI provider to commit and draft a pull request.");
      return;
    }
    setRunningWorktrees((prev) => new Set(prev).add(worktreeId));
    try {
      const result = await aiCommitAllAndGeneratePullRequestDraft(worktreeId);
      setGeneratedPrDrafts((prev) => ({
        ...prev,
        [worktreeId]: { key: Date.now(), draft: { title: result.title, body: result.body } },
      }));
      // Only steer the UI if the user is still on the worktree that finished;
      // otherwise let the draft wait quietly until they return to it.
      if (availabilityWorktree.current === worktreeId) {
        setActiveSubtab("pullRequest");
        setHasUncommittedChanges(false);
      }
      toast.success(
        `Created ${result.commitCount} commit${result.commitCount === 1 ? "" : "s"} and drafted the PR`,
      );
    } catch (cause) {
      toast.error(messageFor(cause));
    } finally {
      setRunningWorktrees((prev) => {
        const next = new Set(prev);
        next.delete(worktreeId);
        return next;
      });
    }
  }, [
    workspace.selectedWorktreeId,
    runningWorktrees,
    hasUncommittedChanges,
    aiAvailable,
    setActiveSubtab,
  ]);

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-white/10 bg-[#11151b] py-2">
        <Button
          aria-label="Expand files sidebar"
          className="text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={toggleCollapsed}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightOpen />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="relative flex shrink-0 flex-col border-l border-white/10 bg-[#0b0d10]"
      style={{ width }}
    >
      <ResizeHandle onResize={setWidth} />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 pl-1 pr-2">
        <Button
          aria-label="Collapse files sidebar"
          className="text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={toggleCollapsed}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightClose />
        </Button>
        <Tabs
          className="min-w-0 flex-1"
          onValueChange={(value) => setActiveSubtab(value as RightSidebarSubtab)}
          value={activeSubtab}
        >
          <TabsList className="h-7">
            <TabsTrigger className="text-xs" value="files">
              Files
            </TabsTrigger>
            <TabsTrigger className="text-xs" value="changes">
              Changes
            </TabsTrigger>
            <TabsTrigger className="text-xs" value="pullRequest">
              Pull Request
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {aiAvailable ? (
          <Button
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            disabled={commitPrRunning || !workspace.selectedWorktreeId || !hasUncommittedChanges}
            onClick={() => void runCommitAndPr()}
            size="sm"
            title="Commit all changes and draft a pull request"
            variant="secondary"
          >
            {commitPrRunning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Icon className="size-3.5" icon="simple-icons:github" />
            )}
            Commit &amp; PR
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeSubtab === "files" ? (
          <FilesTab />
        ) : activeSubtab === "changes" ? (
          <ChangesTab />
        ) : (
          <PullRequestTab
            generatedDraft={generatedPrDraft?.draft ?? null}
            generatedDraftKey={generatedPrDraft?.key}
          />
        )}
      </div>
    </div>
  );
}

/** Left-edge drag handle that resizes the (right-anchored) sidebar. */
function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-cyan-400/40"
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) {
          return;
        }
        dragRef.current = {
          startX: event.clientX,
          startWidth: parent.getBoundingClientRect().width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        onResize(drag.startWidth + (drag.startX - event.clientX));
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
