import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { errorMessage } from "@/lib/errors";

import { Icon } from "@iconify/react";
import { Loader2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";

import { ChangesTab } from "@/components/right-sidebar/ChangesTab";
import { FilesTab } from "@/components/right-sidebar/FilesTab";
import { PullRequestTab } from "@/components/right-sidebar/PullRequestTab";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  aiCommitAllAndGeneratePullRequestDraft,
  type AiPullRequestDraft,
  worktreeChanges,
} from "@/lib/tauri";
import {
  instantTransition,
  motionTransition,
  tabPanelVariants,
  useMotionTransition,
} from "@/lib/motion";
import { useAi } from "@/state/ai-context";
import { type RightSidebarSubtab, useRightSidebar } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import {
  RenderPluginContribution,
  usePluginSidebarTabs,
  type VisiblePluginContribution,
} from "@/plugins/rendering";
import type { SidebarTabDefinition } from "@pragma/plugin";

const COMMIT_PR_REFRESH_INTERVAL_MS = 2000;

/** Width of the collapsed rail, in px — matches the `w-9` the strip used to hard-code. */
const COLLAPSED_WIDTH = 36;

/**
 * Secondary sidebar on the right edge of the workspace, mirroring the left
 * `ProjectSidebar`. Collapses to a thin strip and hosts the Files and Changes
 * subtabs. Rendered as the last flex child of the workspace so the center pane
 * reflows when it collapses (the BrowserView ResizeObserver re-applies native
 * webview bounds automatically).
 */
/** Polls a worktree's uncommitted-changes state (only while AI is available). */
function useCommitPrAvailability(worktreeId: string | null, aiAvailable: boolean) {
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const availabilityWorktree = useRef<string | null>(null);

  const refresh = useCallback(async () => {
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
  }, [worktreeId, aiAvailable]);

  useEffect(() => {
    availabilityWorktree.current = worktreeId;
    setHasUncommittedChanges(false);
    if (!aiAvailable) {
      return;
    }
    return startRefreshLoop(refresh, COMMIT_PR_REFRESH_INTERVAL_MS);
  }, [worktreeId, aiAvailable, refresh]);

  return { hasUncommittedChanges, setHasUncommittedChanges, availabilityWorktree };
}

/** Runs the Commit & PR job per worktree and tracks its generated draft. */
function useCommitAndPrRun(
  worktreeId: string | null,
  aiAvailable: boolean,
  hasUncommittedChanges: boolean,
  setActiveSubtab: (tab: RightSidebarSubtab) => void,
  setHasUncommittedChanges: (value: boolean) => void,
  availabilityWorktree: React.RefObject<string | null>,
) {
  // Commit & PR jobs run in the Rust backend and survive a worktree switch, so
  // we track them per worktree id rather than with a single boolean. That keeps
  // the spinner on the worktree it belongs to and lets a job keep running (and
  // land its draft) while the user works in a different worktree.
  const [runningWorktrees, setRunningWorktrees] = useState<ReadonlySet<string>>(new Set());
  const [generatedPrDrafts, setGeneratedPrDrafts] = useState<
    Record<string, { key: number; draft: AiPullRequestDraft }>
  >({});
  const commitPrRunning = worktreeId ? runningWorktrees.has(worktreeId) : false;
  const generatedPrDraft = worktreeId ? generatedPrDrafts[worktreeId] : undefined;

  const runCommitAndPr = useCallback(async () => {
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
      toast.error(errorMessage(cause));
    } finally {
      setRunningWorktrees((prev) => {
        const next = new Set(prev);
        next.delete(worktreeId);
        return next;
      });
    }
  }, [
    worktreeId,
    runningWorktrees,
    hasUncommittedChanges,
    aiAvailable,
    setActiveSubtab,
    setHasUncommittedChanges,
    availabilityWorktree,
  ]);

  return { commitPrRunning, generatedPrDraft, runCommitAndPr };
}

/** The collapsed strip: a single expand button. */
function CollapsedRightSidebar({ onExpand }: { onExpand: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="bg-elevated flex flex-1 flex-col items-center py-2"
      initial={{ opacity: 0 }}
      transition={motionTransition.fast}
    >
      <Button aria-label="Expand files sidebar" onClick={onExpand} size="icon-sm" variant="ghost">
        <PanelRightOpen />
      </Button>
    </motion.div>
  );
}

/** The header: collapse button, subtab tabs, and the Commit & PR button. */
interface RightSidebarHeaderProps {
  activeSubtab: RightSidebarSubtab;
  aiAvailable: boolean;
  commitPrRunning: boolean;
  hasUncommittedChanges: boolean;
  pluginTabs: VisiblePluginContribution<SidebarTabDefinition>[];
  worktreeId: string | null;
  onCommitPr: () => void;
  onCollapse: () => void;
  setActiveSubtab: (tab: RightSidebarSubtab) => void;
}

function RightSidebarHeader({
  activeSubtab,
  aiAvailable,
  commitPrRunning,
  hasUncommittedChanges,
  pluginTabs,
  worktreeId,
  onCommitPr,
  onCollapse,
  setActiveSubtab,
}: RightSidebarHeaderProps) {
  return (
    <div className="bg-sidebar flex h-9 shrink-0 items-center gap-1 border-b border-sidebar-border pl-1 pr-2">
      <Button
        aria-label="Collapse files sidebar"
        onClick={onCollapse}
        size="icon-sm"
        variant="ghost"
      >
        <PanelRightClose />
      </Button>
      <Tabs
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        onValueChange={(value) => setActiveSubtab(value as RightSidebarSubtab)}
        value={activeSubtab}
      >
        <TabsList className="h-7 min-w-full w-max justify-start group-data-horizontal/tabs:h-7">
          <TabsTrigger className="shrink-0 text-xs" value="files">
            Files
          </TabsTrigger>
          <TabsTrigger className="shrink-0 text-xs" value="changes">
            Changes
          </TabsTrigger>
          <TabsTrigger className="shrink-0 text-xs" value="pullRequest">
            Pull Request
          </TabsTrigger>
          {pluginTabs.map((tab) => {
            const PluginIcon = tab.contribution.icon;
            return (
              <TabsTrigger
                className="shrink-0 gap-1.5 text-xs"
                key={tab.key}
                value={pluginTabValue(tab)}
              >
                {PluginIcon ? <PluginIcon className="size-3.5" /> : null}
                <span>{tab.contribution.title}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      {aiAvailable ? (
        <Button
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          disabled={commitPrRunning || !worktreeId || !hasUncommittedChanges}
          onClick={onCommitPr}
          size="sm"
          title="Commit all changes and draft a pull request"
          variant="default"
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
  );
}

/** The active subtab body. */
function RightSidebarBody({
  activeSubtab,
  generatedPrDraft,
  pluginTabs,
}: {
  activeSubtab: RightSidebarSubtab;
  generatedPrDraft: { key: number; draft: AiPullRequestDraft } | undefined;
  pluginTabs: VisiblePluginContribution<SidebarTabDefinition>[];
}) {
  if (activeSubtab === "files") {
    return <FilesTab />;
  }
  if (activeSubtab === "changes") {
    return <ChangesTab />;
  }
  const pluginTab = pluginTabs.find((tab) => pluginTabValue(tab) === activeSubtab);
  if (pluginTab) {
    return (
      <RenderPluginContribution
        component={pluginTab.contribution.component}
        config={pluginTab.record.config}
        pluginId={pluginTab.pluginId}
        resetKey={pluginTab.key}
      />
    );
  }
  return (
    <PullRequestTab
      generatedDraft={generatedPrDraft?.draft ?? null}
      generatedDraftKey={generatedPrDraft?.key}
    />
  );
}

function pluginTabValue(tab: VisiblePluginContribution<SidebarTabDefinition>): RightSidebarSubtab {
  return `plugin:${tab.pluginId}:${tab.contribution.id}`;
}

/**
 * Which way the body should slide: +1 when moving right along the tab strip,
 * -1 when moving left, so the panel travels with the user's intent rather than
 * always entering from the same edge.
 */
function useSubtabDirection(order: readonly RightSidebarSubtab[], active: RightSidebarSubtab) {
  const previousIndex = useRef(order.indexOf(active));
  const index = order.indexOf(active);
  const direction = index < previousIndex.current ? -1 : 1;
  useEffect(() => {
    previousIndex.current = index;
  }, [index]);
  return direction;
}

export function RightSidebar() {
  const { collapsed, activeSubtab, width, toggleCollapsed, setActiveSubtab, setWidth } =
    useRightSidebar();
  const [resizing, setResizing] = useState(false);
  const workspace = useWorkspace();
  const { available: aiAvailable } = useAi();
  const pluginTabs = usePluginSidebarTabs(workspace.selectedProjectId);
  const worktreeId = workspace.selectedWorktreeId;
  const { hasUncommittedChanges, setHasUncommittedChanges, availabilityWorktree } =
    useCommitPrAvailability(worktreeId, aiAvailable);
  const { commitPrRunning, generatedPrDraft, runCommitAndPr } = useCommitAndPrRun(
    worktreeId,
    aiAvailable,
    hasUncommittedChanges,
    setActiveSubtab,
    setHasUncommittedChanges,
    availabilityWorktree,
  );

  useEffect(() => {
    if (
      activeSubtab.startsWith("plugin:") &&
      !pluginTabs.some((tab) => pluginTabValue(tab) === activeSubtab)
    ) {
      setActiveSubtab("files");
    }
  }, [activeSubtab, pluginTabs, setActiveSubtab]);

  const subtabOrder: RightSidebarSubtab[] = [
    "files",
    "changes",
    "pullRequest",
    ...pluginTabs.map(pluginTabValue),
  ];
  const direction = useSubtabDirection(subtabOrder, activeSubtab);
  const panelTransition = useMotionTransition(
    resizing ? instantTransition : motionTransition.panel,
  );

  return (
    // Width animates on one element rather than swapping in a separate collapsed
    // strip, so the centre pane (and the terminal resizing behind it) reflows
    // smoothly instead of in a single jump. Mirrors `ProjectSidebar`.
    <motion.div
      animate={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      className="app-content bg-canvas relative flex shrink-0 flex-col overflow-hidden border-l border-sidebar-border"
      initial={false}
      transition={panelTransition}
    >
      {collapsed ? (
        <CollapsedRightSidebar onExpand={toggleCollapsed} />
      ) : (
        <>
          <ResizeHandle
            onResize={setWidth}
            onResizeEnd={() => setResizing(false)}
            onResizeStart={() => setResizing(true)}
          />
          <RightSidebarHeader
            activeSubtab={activeSubtab}
            aiAvailable={aiAvailable}
            commitPrRunning={commitPrRunning}
            hasUncommittedChanges={hasUncommittedChanges}
            onCollapse={toggleCollapsed}
            onCommitPr={() => void runCommitAndPr()}
            pluginTabs={pluginTabs}
            setActiveSubtab={setActiveSubtab}
            worktreeId={worktreeId}
          />
          <div className="bg-canvas min-h-0 flex-1 overflow-hidden">
            {/* `mode="wait"` because these panels already remount on every
                subtab change; overlapping them would double-mount the file tree. */}
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate="visible"
                className="h-full"
                exit="exit"
                initial="hidden"
                key={activeSubtab}
                transition={motionTransition.fast}
                variants={tabPanelVariants(direction)}
              >
                <RightSidebarBody
                  activeSubtab={activeSubtab}
                  generatedPrDraft={generatedPrDraft}
                  pluginTabs={pluginTabs}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        </>
      )}
    </motion.div>
  );
}

/** Left-edge drag handle that resizes the (right-anchored) sidebar. */
function ResizeHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) {
          return;
        }
        dragRef.current = {
          startX: event.clientX,
          startWidth: parent.getBoundingClientRect().width,
        };
        onResizeStart();
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
        onResizeEnd();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
