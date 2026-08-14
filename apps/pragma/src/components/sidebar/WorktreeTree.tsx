import {
  forwardRef,
  Fragment,
  type ComponentPropsWithoutRef,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Icon } from "@iconify/react";
import type { Worktree } from "@pragma/constants";
import {
  ChevronRight,
  Copy,
  EyeOff,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Separator } from "@/components/ui/separator";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { WorktreeDeleteDialog } from "@/components/dialogs/WorktreeDeleteDialog";
import { editorLaunchers } from "@/lib/editor-launchers";
import {
  findPullRequestForBranch,
  pullRequestLifecycle,
  type GitHubPrLifecycle,
} from "@/lib/github";
import { subscribeToWorktreeFiles } from "@/lib/file-watch";
import { githubRepoRef, worktreesMergedStatus } from "@/lib/tauri";
import { buildWorktreeTree, type WorktreeNode } from "@/lib/worktree-tree";
import { commitOnEnterCancelOnEscape } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { useGitHub } from "@/state/github-context";
import { useKanban } from "@/state/kanban-context";
import { useWorktreeAgentStatus } from "@/state/agent-status-store";
import { toggleWorktreePin, useWorktreePins } from "@/state/worktree-pins";
import {
  FanoutIndicator,
  FanoutMembersSlot,
  useFanoutForParent,
} from "@/components/sidebar/FanoutGroup";
import { WorktreeRowFrame } from "@/components/sidebar/WorktreeRowFrame";
import { attemptWorktreeIds } from "@/lib/fanout";
import { useFanouts } from "@/state/fanouts-context";
import { useWorkspace } from "@/state/workspace-context";

/** Low-frequency safety net for ref-only git changes that file watches cannot see. */
const MERGED_STATUS_FALLBACK_INTERVAL_MS = 30_000;
/** Caps refreshes during formatter/save bursts at the old polling frequency. */
const MERGED_STATUS_MIN_REFRESH_INTERVAL_MS = 2000;
/** Coalesces the filesystem events emitted by one logical save. */
const MERGED_STATUS_INVALIDATION_DEBOUNCE_MS = 250;
/** PR lifecycle poll — matches the Pull Request tab so both stay in lockstep. */
const PR_STATUS_REFRESH_INTERVAL_MS = 10_000;

/** True when both maps hold exactly the same worktree-id → merged entries. */
function sameMergedStatus(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

/** Applies an authoritative full or partial merged-status response. */
function applyMergedStatusResponse(
  previous: Record<string, boolean>,
  requestedWorktreeIds: string[],
  response: Record<string, boolean>,
  fullRefresh: boolean,
): Record<string, boolean> {
  if (fullRefresh) return sameMergedStatus(previous, response) ? previous : response;

  const next = { ...previous };
  // A successful partial response is authoritative for exactly the requested
  // ids. Drop stale entries if an unexpected old daemon omits one, matching
  // the full-response behavior.
  for (const worktreeId of requestedWorktreeIds) delete next[worktreeId];
  Object.assign(next, response);
  return sameMergedStatus(previous, next) ? previous : next;
}

/** Removes statuses whose refresh failed, matching the historical full-poll behavior. */
function applyMergedStatusFailure(
  previous: Record<string, boolean>,
  requestedWorktreeIds: string[],
  fullRefresh: boolean,
): Record<string, boolean> {
  if (fullRefresh) return Object.keys(previous).length === 0 ? previous : {};

  const next = { ...previous };
  for (const worktreeId of requestedWorktreeIds) delete next[worktreeId];
  return sameMergedStatus(previous, next) ? previous : next;
}

/** True when both maps hold the same worktree-id → PR lifecycle entries. */
function samePrLifecycle(
  a: Record<string, GitHubPrLifecycle>,
  b: Record<string, GitHubPrLifecycle>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

/**
 * Icon color for the worktree merge glyph from PR lifecycle:
 * open → green, merged → purple (`skill`), closed → red. Draft / none stay default.
 */
function prLifecycleIconClass(lifecycle: GitHubPrLifecycle | undefined): string | undefined {
  switch (lifecycle) {
    case "open":
      return "text-success";
    case "merged":
      return "text-skill";
    case "closed":
      return "text-destructive";
    case "merging":
      return "text-warning";
    default:
      return undefined;
  }
}

/** Branch vs merge glyph + color for a worktree row. */
function worktreeGlyph(
  merged: boolean,
  prLifecycle: GitHubPrLifecycle | undefined,
): { Icon: typeof GitBranch; className: string | undefined } {
  return {
    Icon: merged || prLifecycle === "merged" ? GitMerge : GitBranch,
    className: prLifecycleIconClass(prLifecycle) ?? (merged ? "text-success" : undefined),
  };
}

/**
 * Poll GitHub PR lifecycle per child worktree (cached; background revalidate).
 * Green = open PR, purple = merged, red = closed. Same cadence as the PR tab.
 */
function useWorktreePrLifecycles(
  worktrees: Worktree[],
  authenticated: boolean,
): Record<string, GitHubPrLifecycle> {
  const [prLifecycleByWorktreeId, setPrLifecycleByWorktreeId] = useState<
    Record<string, GitHubPrLifecycle>
  >({});

  useEffect(() => {
    const childWorktrees = worktrees.filter((worktree) => !worktree.isMain && worktree.parentId);
    if (!authenticated || childWorktrees.length === 0) {
      setPrLifecycleByWorktreeId((previous) =>
        Object.keys(previous).length === 0 ? previous : {},
      );
      return;
    }
    let cancelled = false;
    let refreshInFlight = false;

    async function refreshPrLifecycle() {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const entries = await Promise.all(
          childWorktrees.map(async (worktree) => {
            try {
              const repo = await githubRepoRef(worktree.id);
              const pr = await findPullRequestForBranch(repo, { includeClosed: true });
              return [worktree.id, pullRequestLifecycle(pr)] as const;
            } catch {
              // Failed lookup: report no lifecycle at all rather than "none",
              // so a transient GitHub error can't sort the row into the no-PR
              // bucket ahead of worktrees whose PRs did resolve.
              return [worktree.id, undefined] as const;
            }
          }),
        );
        if (cancelled) return;
        setPrLifecycleByWorktreeId((previous) => {
          const next: Record<string, GitHubPrLifecycle> = {};
          for (const [id, lifecycle] of entries) {
            // Carry the last known lifecycle forward across a failed refresh.
            const resolved = lifecycle ?? previous[id];
            if (resolved !== undefined) next[id] = resolved;
          }
          return samePrLifecycle(previous, next) ? previous : next;
        });
      } finally {
        refreshInFlight = false;
      }
    }

    void refreshPrLifecycle();
    const interval = setInterval(() => {
      if (!document.hidden) void refreshPrLifecycle();
    }, PR_STATUS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [worktrees, authenticated]);

  return prLifecycleByWorktreeId;
}

/** Tracks local merged-into-parent status for child worktrees.
 *
 * The shared main-root filesystem watch identifies changed standard child
 * checkouts and invalidates only those rows (subject to a short burst
 * debounce). A low-frequency full poll remains necessary for ref-only changes,
 * such as a merge performed in an external terminal, because the watcher
 * deliberately filters `.git` metadata.
 */
function useWorktreeMergedStatus(worktrees: Worktree[]): Record<string, boolean> {
  const [mergedByWorktreeId, setMergedByWorktreeId] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const childWorktrees = worktrees.filter((worktree) => !worktree.isMain && worktree.parentId);
    const mainWorktree = worktrees.find((worktree) => worktree.isMain);
    if (childWorktrees.length === 0) {
      setMergedByWorktreeId((previous) => (Object.keys(previous).length === 0 ? previous : {}));
      return;
    }

    const allWorktreeIds = childWorktrees.map((worktree) => worktree.id);
    const knownWorktreeIds = new Set(allWorktreeIds);
    let cancelled = false;
    let refreshInFlight = false;
    let fullRefreshQueued = false;
    const queuedWorktreeIds = new Set<string>();
    let pendingFullRefresh = false;
    const pendingWorktreeIds = new Set<string>();
    let lastRefreshStartedAt = Number.NEGATIVE_INFINITY;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let scheduledFullRefresh = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    function clearRefreshTimer() {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      scheduledFullRefresh = false;
    }

    function clearFallbackTimer() {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    }

    function scheduleFallback() {
      clearFallbackTimer();
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (document.hidden) {
          scheduleFallback();
        } else {
          void refreshMergedStatus(allWorktreeIds, true);
        }
      }, MERGED_STATUS_FALLBACK_INTERVAL_MS);
    }

    function queueRefreshDuringRequest(worktreeIds: string[], fullRefresh: boolean) {
      if (fullRefresh) {
        fullRefreshQueued = true;
        queuedWorktreeIds.clear();
      } else if (!fullRefreshQueued) {
        for (const worktreeId of worktreeIds) queuedWorktreeIds.add(worktreeId);
      }
    }

    function scheduleRefreshQueuedDuringRequest(completedFullRefresh: boolean) {
      if (cancelled) return;
      if (completedFullRefresh) scheduleFallback();

      const runFullRefresh = fullRefreshQueued;
      const nextWorktreeIds = runFullRefresh ? allWorktreeIds : Array.from(queuedWorktreeIds);
      fullRefreshQueued = false;
      queuedWorktreeIds.clear();
      if (nextWorktreeIds.length === 0) return;

      const elapsed = Date.now() - lastRefreshStartedAt;
      const delay = Math.max(0, MERGED_STATUS_MIN_REFRESH_INTERVAL_MS - elapsed);
      scheduledFullRefresh = runFullRefresh;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        scheduledFullRefresh = false;
        void refreshMergedStatus(nextWorktreeIds, runFullRefresh);
      }, delay);
    }

    async function refreshMergedStatus(worktreeIds: string[], fullRefresh: boolean) {
      if (cancelled) return;
      if (refreshInFlight) {
        queueRefreshDuringRequest(worktreeIds, fullRefresh);
        return;
      }
      refreshInFlight = true;
      clearRefreshTimer();
      if (fullRefresh) {
        clearFallbackTimer();
        pendingFullRefresh = false;
        pendingWorktreeIds.clear();
      }
      lastRefreshStartedAt = Date.now();
      try {
        const merged = await worktreesMergedStatus(worktreeIds);
        if (!cancelled) {
          setMergedByWorktreeId((previous) =>
            applyMergedStatusResponse(previous, worktreeIds, merged, fullRefresh),
          );
        }
      } catch {
        if (!cancelled) {
          setMergedByWorktreeId((previous) =>
            applyMergedStatusFailure(previous, worktreeIds, fullRefresh),
          );
        }
      } finally {
        refreshInFlight = false;
        scheduleRefreshQueuedDuringRequest(fullRefresh);
      }
    }

    function invalidateMergedStatus(worktreeIds?: string[]) {
      if (cancelled) return;
      if (worktreeIds === undefined || scheduledFullRefresh) {
        if (worktreeIds === undefined) clearFallbackTimer();
        pendingFullRefresh = true;
        pendingWorktreeIds.clear();
      } else if (!pendingFullRefresh) {
        for (const worktreeId of worktreeIds) pendingWorktreeIds.add(worktreeId);
      }
      clearRefreshTimer();
      const elapsed = Date.now() - lastRefreshStartedAt;
      const delay = Math.max(
        MERGED_STATUS_INVALIDATION_DEBOUNCE_MS,
        MERGED_STATUS_MIN_REFRESH_INTERVAL_MS - elapsed,
      );
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const runFullRefresh = pendingFullRefresh;
        const worktreeIdsToRefresh = runFullRefresh
          ? allWorktreeIds
          : Array.from(pendingWorktreeIds);
        pendingFullRefresh = false;
        pendingWorktreeIds.clear();
        if (worktreeIdsToRefresh.length > 0) {
          void refreshMergedStatus(worktreeIdsToRefresh, runFullRefresh);
        }
      }, delay);
    }

    // Standard child checkouts live below `<main>/.pragma/worktrees`, so the
    // existing ref-counted main-root watch observes all of them without opening
    // one recursive OS watcher per row. Nonstandard locations still converge
    // via the fallback poll.
    const unsubscribe = mainWorktree
      ? subscribeToWorktreeFiles(mainWorktree.id, (change) => {
          const pathParts = change.path.split("/");
          const changedWorktreeId =
            pathParts[0] === ".pragma" && pathParts[1] === "worktrees" ? pathParts[2] : undefined;
          if (changedWorktreeId && knownWorktreeIds.has(changedWorktreeId)) {
            invalidateMergedStatus([changedWorktreeId]);
          }
        })
      : undefined;
    const refreshWhenVisible = () => {
      if (!document.hidden) invalidateMergedStatus();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void refreshMergedStatus(allWorktreeIds, true);

    return () => {
      cancelled = true;
      clearRefreshTimer();
      clearFallbackTimer();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      unsubscribe?.();
    };
  }, [worktrees]);

  return mergedByWorktreeId;
}

interface WorktreeTreeProps {
  onCreateChild: (parentWorktreeId: string) => void;
}

/** Collapsible list of hidden worktrees under the main tree. */
function HiddenWorktreesSection({
  hidden,
  mergedByWorktreeId,
  prLifecycleByWorktreeId,
  onUnhide,
}: {
  hidden: Worktree[];
  mergedByWorktreeId: Record<string, boolean>;
  prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle>;
  onUnhide: (worktreeId: string) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  return (
    <div className="pt-1">
      <button
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60"
        onClick={() => setShowHidden((value) => !value)}
      >
        <ChevronRight className={cn("size-3 opacity-60", showHidden && "rotate-90")} />
        {showHidden ? "Hide" : "Show"} {hidden.length} hidden
      </button>
      {showHidden
        ? hidden.map((worktree) => (
            <HiddenWorktreeRow
              key={worktree.id}
              merged={mergedByWorktreeId[worktree.id] === true}
              onUnhide={() => onUnhide(worktree.id)}
              prLifecycle={prLifecycleByWorktreeId[worktree.id]}
              worktree={worktree}
            />
          ))
        : null}
    </div>
  );
}

export function WorktreeTree({ onCreateChild }: WorktreeTreeProps) {
  const workspace = useWorkspace();
  const { authenticated } = useGitHub();
  const pinTimes = useWorktreePins();
  const worktrees = useMemo(
    () =>
      workspace.selectedProjectId ? (workspace.worktrees[workspace.selectedProjectId] ?? []) : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );
  const hidden = worktrees.filter((w) => w.hidden);
  const mergedByWorktreeId = useWorktreeMergedStatus(worktrees);
  const prLifecycleByWorktreeId = useWorktreePrLifecycles(worktrees, authenticated);
  const { fanouts } = useFanouts();
  // Attempts are rendered under their fanout group, not as ordinary children:
  // a nested worktree and an attempt look identical from `parentId` alone.
  const attempts = useMemo(() => attemptWorktreeIds(fanouts), [fanouts]);
  const tree = useMemo(
    () =>
      buildWorktreeTree(worktrees, {
        predicate: (w) => !w.hidden && !attempts.has(w.id),
        pinTimes,
        prLifecycles: prLifecycleByWorktreeId,
      }),
    [worktrees, attempts, pinTimes, prLifecycleByWorktreeId],
  );

  if (tree.length === 0 && hidden.length === 0) {
    return <p className="px-2 py-6 text-sm text-muted-foreground">No worktrees loaded.</p>;
  }

  // Pinned rows sort first; the rule below the last one sets them apart from
  // the rest of the tree. Only drawn when both sides are non-empty.
  const pinnedRootCount = tree.filter((node) => pinTimes.has(node.worktree.id)).length;
  const separatorIndex =
    pinnedRootCount > 0 && pinnedRootCount < tree.length ? pinnedRootCount : -1;

  return (
    <div className="space-y-1">
      {tree.map((node, index) => (
        <Fragment key={node.worktree.id}>
          {index === separatorIndex ? <Separator className="my-2" /> : null}
          <WorktreeRow
            depth={0}
            mergedByWorktreeId={mergedByWorktreeId}
            node={node}
            onCreateChild={onCreateChild}
            prLifecycleByWorktreeId={prLifecycleByWorktreeId}
          />
        </Fragment>
      ))}
      {hidden.length > 0 ? (
        <HiddenWorktreesSection
          hidden={hidden}
          mergedByWorktreeId={mergedByWorktreeId}
          onUnhide={(id) => void workspace.hideWorktree(id, false)}
          prLifecycleByWorktreeId={prLifecycleByWorktreeId}
        />
      ) : null}
    </div>
  );
}

/** Copy a value to the clipboard and toast the result (or an error). */
async function copyToClipboard(value: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Inline-rename state for a worktree row (focus/select, commit/cancel). */
function useWorktreeRename(worktree: Worktree): {
  renaming: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  startRename: () => void;
  commitRename: () => void;
  cancelRename: () => void;
} {
  const workspace = useWorkspace();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(worktree.title ?? worktree.branch);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);
  const startRename = useCallback(() => {
    setRenameValue(worktree.title ?? worktree.branch);
    setRenaming(true);
  }, [worktree.title, worktree.branch]);
  const commitRename = useCallback(() => {
    setRenaming(false);
    const next = renameValue.trim();
    const current = worktree.title ?? worktree.branch;
    if (next === current) return;
    void workspace.renameWorktree(worktree.id, next);
  }, [worktree.id, worktree.title, worktree.branch, renameValue, workspace]);
  const cancelRename = useCallback(() => setRenaming(false), []);
  return {
    renaming,
    renameValue,
    setRenameValue,
    inputRef,
    startRename,
    commitRename,
    cancelRename,
  };
}

type RenameApi = ReturnType<typeof useWorktreeRename>;

/** Resolve a worktree's display label (`main` for the main worktree). */
function worktreeLabel(worktree: Worktree): string {
  return worktree.isMain ? "main" : (worktree.title ?? worktree.branch);
}

interface WorktreeRowLabelState {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  isMain: boolean;
  label: string;
  merged: boolean;
  prLifecycle: GitHubPrLifecycle | undefined;
  pinned: boolean;
  selected: boolean;
  WorktreeIcon: typeof GitBranch;
  agentStatus: ReturnType<typeof useWorktreeAgentStatus>;
  worktreeId: string;
}

interface WorktreeRowLabelActions {
  startRename: () => void;
  toggleExpanded: () => void;
  handleSelect: () => void;
  handleCreateChild: () => void;
  handleTogglePin: () => void;
  openDelete: () => void;
}

interface WorktreeRowLabelProps extends ComponentPropsWithoutRef<"div"> {
  row: WorktreeRowLabelState;
  actions: WorktreeRowLabelActions;
  rename: RenameApi;
}

/** The expand/collapse caret for a worktree row (or a spacer for childless rows). */
function WorktreeExpandCaret({
  hasChildren,
  expanded,
  label,
  toggleExpanded,
}: {
  hasChildren: boolean;
  expanded: boolean;
  label: string;
  toggleExpanded: () => void;
}) {
  if (!hasChildren) return <span className="w-3" />;
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      className="flex w-3 items-center justify-center"
      onClick={toggleExpanded}
    >
      <ChevronRight className={cn("size-3 opacity-60", expanded && "rotate-90")} />
    </button>
  );
}

/** The worktree name: an inline rename input when renaming, otherwise the label. */
function WorktreeNameField({ rename, label }: { rename: RenameApi; label: string }) {
  if (!rename.renaming) return <span className="min-w-0 flex-1 truncate">{label}</span>;
  return (
    <input
      ref={rename.inputRef}
      aria-label={`Rename ${label}`}
      className="w-0 min-w-0 flex-1 rounded bg-muted px-1 text-left text-sm text-foreground outline-none ring-1 ring-ring"
      value={rename.renameValue}
      onBlur={rename.commitRename}
      onChange={(event) => rename.setRenameValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={commitOnEnterCancelOnEscape(rename.commitRename, rename.cancelRename)}
    />
  );
}

/** Always-visible pin glyph on pinned rows; click unpins. */
function WorktreePinnedIndicator({ label, onUnpin }: { label: string; onUnpin: () => void }) {
  return (
    <IconButton
      aria-label={`Unpin ${label}`}
      label="Unpin"
      size="icon-xs"
      variant="ghost"
      onClick={onUnpin}
    >
      <Pin className="fill-current" />
    </IconButton>
  );
}

/**
 * A row action that is out of the layout until the row is hovered or focused,
 * rather than merely transparent: reserving its width on every row would eat
 * space the worktree name could otherwise use before truncating.
 */
const HOVER_ACTION_CLASS = "hidden group-hover:inline-flex group-focus-within:inline-flex";

/** Row actions: pin toggle, plus hover-revealed create-child and delete on
 *  nested worktrees. The main row only carries its pin toggle — creating a
 *  worktree off main lives in the sidebar titlebar. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated components (ReviewThreadActions, WorktreeContextMenu); not extractable logic.
function WorktreeRowActions({
  isMain,
  label,
  pinned,
  handleCreateChild,
  handleTogglePin,
  openDelete,
}: {
  isMain: boolean;
  label: string;
  pinned: boolean;
  handleCreateChild: () => void;
  handleTogglePin: () => void;
  openDelete: () => void;
}) {
  const pinButton = pinned ? null : (
    <IconButton
      aria-label={`Pin ${label}`}
      className={HOVER_ACTION_CLASS}
      label="Pin"
      size="icon-xs"
      variant="ghost"
      onClick={handleTogglePin}
    >
      <Pin />
    </IconButton>
  );
  if (isMain) {
    return <>{pinButton}</>;
  }
  return (
    <>
      {pinButton}
      <IconButton
        aria-label={`Create child worktree from ${label}`}
        className={HOVER_ACTION_CLASS}
        label="New child"
        size="icon-xs"
        variant="ghost"
        onClick={handleCreateChild}
      >
        <GitBranchPlus />
      </IconButton>
      <IconButton
        aria-label={`Delete worktree ${label}`}
        className={HOVER_ACTION_CLASS}
        label="Delete worktree"
        size="icon-xs"
        variant="ghost"
        onClick={openDelete}
      >
        <Trash2 className="text-destructive" />
      </IconButton>
    </>
  );
}

/** The row's visible label: expand caret, branch icon, name/rename input, actions. */
const WorktreeRowLabel = forwardRef<HTMLDivElement, WorktreeRowLabelProps>(
  function WorktreeRowLabel({ row, actions, rename, className, style, ...props }, ref) {
    const {
      depth,
      expanded,
      hasChildren,
      isMain,
      label,
      merged,
      prLifecycle,
      pinned,
      selected,
      WorktreeIcon,
      agentStatus,
      worktreeId,
    } = row;
    const {
      startRename,
      toggleExpanded,
      handleSelect,
      handleCreateChild,
      handleTogglePin,
      openDelete,
    } = actions;
    const iconClass = prLifecycleIconClass(prLifecycle) ?? (merged ? "text-success" : undefined);
    return (
      <WorktreeRowFrame
        ref={ref}
        className={className}
        style={style}
        depth={depth}
        selected={selected}
        caret={
          <WorktreeExpandCaret
            expanded={expanded}
            hasChildren={hasChildren}
            label={label}
            toggleExpanded={toggleExpanded}
          />
        }
        onActivate={handleSelect}
        onDoubleActivate={isMain ? undefined : startRename}
        icon={<WorktreeIcon className={cn("size-3.5 shrink-0", iconClass)} />}
        label={<WorktreeNameField label={label} rename={rename} />}
        status={<AgentStatusDot status={agentStatus} />}
        trailing={
          <>
            <FanoutIndicator label={label} worktreeId={worktreeId} />
            {pinned ? <WorktreePinnedIndicator label={label} onUnpin={handleTogglePin} /> : null}
            <WorktreeRowActions
              handleCreateChild={handleCreateChild}
              handleTogglePin={handleTogglePin}
              isMain={isMain}
              label={label}
              openDelete={openDelete}
              pinned={pinned}
            />
          </>
        }
        {...props}
      />
    );
  },
);

/** The row's right-click menu: rename, pin, copy path/branch, open in editor, hide, delete. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated components (ReviewThreadActions, WorktreeRowActions); not extractable logic.
function WorktreeContextMenu({
  isMain,
  pinned,
  worktree,
  startRename,
  handleTogglePin,
  openDelete,
}: {
  isMain: boolean;
  pinned: boolean;
  worktree: Worktree;
  startRename: () => void;
  handleTogglePin: () => void;
  openDelete: () => void;
}) {
  const workspace = useWorkspace();
  const editorDisabled = workspace.remoteWorktrees[worktree.id] === true;
  const copyPath = useCallback(
    () => void copyToClipboard(worktree.path, "Copied worktree path"),
    [worktree.path],
  );
  const copyBranch = useCallback(
    () => void copyToClipboard(worktree.branch, "Copied branch name"),
    [worktree.branch],
  );
  const hide = useCallback(
    () => void workspace.hideWorktree(worktree.id, true),
    [workspace, worktree.id],
  );
  const openEditor = useCallback(
    (editorId: string) => void workspace.openWorktreeInEditor(worktree.id, editorId),
    [workspace, worktree.id],
  );
  return (
    <ContextMenuContent>
      <ContextMenuItem disabled={isMain} onSelect={isMain ? undefined : startRename}>
        <Pencil />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={handleTogglePin}>
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={copyPath}>
        <Copy />
        Copy worktree path
      </ContextMenuItem>
      <ContextMenuItem onSelect={copyBranch}>
        <Copy />
        Copy branch name
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger
          className="data-disabled:pointer-events-none data-disabled:opacity-50"
          disabled={editorDisabled}
        >
          <Icon
            className="size-4"
            icon={editorLaunchers[0]?.brandIcon ?? "lucide:square-terminal"}
            style={{ color: editorLaunchers[0]?.brandColor }}
          />
          Open in editor
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {editorLaunchers.map((editor) => (
            <ContextMenuItem
              disabled={editorDisabled}
              key={editor.id}
              onSelect={editorDisabled ? undefined : () => openEditor(editor.id)}
            >
              <Icon
                className="size-4"
                icon={editor.brandIcon}
                style={{ color: editor.brandColor }}
              />
              {editor.name}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={hide}>
        <EyeOff />
        Hide
      </ContextMenuItem>
      {isMain ? null : (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={openDelete}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function WorktreeRow({
  node,
  depth,
  onCreateChild,
  mergedByWorktreeId,
  prLifecycleByWorktreeId,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateChild: (parentWorktreeId: string) => void;
  mergedByWorktreeId: Record<string, boolean>;
  prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle>;
}) {
  const {
    agentStatus,
    deleteOpen,
    expanded,
    handleCreateChild,
    handleSelect,
    handleTogglePin,
    hasChildren,
    isMain,
    label,
    merged,
    openDelete,
    pinned,
    prLifecycle,
    rename,
    selected,
    setDeleteOpen,
    toggleExpanded,
    WorktreeIcon,
  } = useWorktreeRow(node, onCreateChild, mergedByWorktreeId, prLifecycleByWorktreeId);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <WorktreeRowLabel
            actions={{
              handleCreateChild,
              handleSelect,
              handleTogglePin,
              openDelete,
              startRename: rename.startRename,
              toggleExpanded,
            }}
            rename={rename}
            row={{
              agentStatus,
              depth,
              expanded,
              hasChildren,
              isMain,
              label,
              merged,
              prLifecycle,
              pinned,
              selected,
              WorktreeIcon,
              worktreeId: node.worktree.id,
            }}
          />
        </ContextMenuTrigger>
        <WorktreeContextMenu
          handleTogglePin={handleTogglePin}
          isMain={isMain}
          openDelete={openDelete}
          pinned={pinned}
          startRename={rename.startRename}
          worktree={node.worktree}
        />
      </ContextMenu>
      {!isMain ? (
        <WorktreeDeleteDialog
          open={deleteOpen}
          trigger={null}
          worktreeId={node.worktree.id}
          worktreeLabel={label}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
      {expanded ? (
        <WorktreeChildren
          depth={depth}
          mergedByWorktreeId={mergedByWorktreeId}
          node={node}
          onCreateChild={onCreateChild}
          prLifecycleByWorktreeId={prLifecycleByWorktreeId}
        />
      ) : null}
    </div>
  );
}

/** Derived state and handlers for one worktree row, hoisted out of the render
 * body so the component stays a small, flat return. */
function useWorktreeRow(
  node: WorktreeNode,
  onCreateChild: (parentWorktreeId: string) => void,
  mergedByWorktreeId: Record<string, boolean>,
  prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle>,
) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const rename = useWorktreeRename(node.worktree);
  const [expanded, setExpanded] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const selected = workspace.selectedWorktreeId === node.worktree.id;
  const label = worktreeLabel(node.worktree);
  // Fanout attempts hang under the row like children do, so the caret has to
  // account for them — otherwise a parent with only attempts can't be collapsed.
  const fanout = useFanoutForParent(node.worktree.id);
  const hasChildren = node.children.length > 0 || fanout !== null;
  const isMain = node.worktree.isMain;
  const pinned = useWorktreePins().has(node.worktree.id);
  const merged = mergedByWorktreeId[node.worktree.id] === true;
  const prLifecycle = prLifecycleByWorktreeId[node.worktree.id];
  const { Icon: WorktreeIcon } = worktreeGlyph(merged, prLifecycle);
  const agentStatus = useWorktreeAgentStatus(node.worktree.id);

  const handleSelect = useCallback(() => {
    workspace.selectWorktree(node.worktree.id);
    // Selecting a worktree always returns to the terminal view, even when the
    // prompt board is the visible surface.
    kanban.exitBoard();
  }, [workspace, kanban, node.worktree.id]);
  const handleCreateChild = useCallback(() => {
    workspace.selectWorktree(node.worktree.id);
    onCreateChild(node.worktree.id);
  }, [workspace, node.worktree.id, onCreateChild]);
  const handleTogglePin = useCallback(() => {
    toggleWorktreePin(node.worktree.id);
  }, [node.worktree.id]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const openDelete = useCallback(() => setDeleteOpen(true), []);

  return {
    agentStatus,
    deleteOpen,
    expanded,
    handleCreateChild,
    handleSelect,
    handleTogglePin,
    hasChildren,
    isMain,
    label,
    merged,
    openDelete,
    pinned,
    prLifecycle,
    rename,
    selected,
    setDeleteOpen,
    toggleExpanded,
    WorktreeIcon,
  };
}

/**
 * What hangs under an expanded worktree row: its fanout attempts (when it has
 * a fanout), then its ordinary child worktrees. The attempts are already
 * filtered out of `node.children`, so nothing is rendered twice.
 */
function WorktreeChildren({
  node,
  depth,
  onCreateChild,
  mergedByWorktreeId,
  prLifecycleByWorktreeId,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateChild: (parentWorktreeId: string) => void;
  mergedByWorktreeId: Record<string, boolean>;
  prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle>;
}) {
  return (
    <>
      <FanoutMembersSlot depth={depth + 1} worktreeId={node.worktree.id} />
      {node.children.map((child) => (
        <WorktreeRow
          key={child.worktree.id}
          depth={depth + 1}
          node={child}
          onCreateChild={onCreateChild}
          mergedByWorktreeId={mergedByWorktreeId}
          prLifecycleByWorktreeId={prLifecycleByWorktreeId}
        />
      ))}
    </>
  );
}

function HiddenWorktreeRow({
  worktree,
  merged,
  prLifecycle,
  onUnhide,
}: {
  worktree: Worktree;
  merged: boolean;
  prLifecycle: GitHubPrLifecycle | undefined;
  onUnhide: () => void;
}) {
  const label = worktree.title ?? worktree.branch;
  const { Icon: WorktreeIcon, className: iconClass } = worktreeGlyph(merged, prLifecycle);
  return (
    <div className="mt-1 flex items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <WorktreeIcon className={cn("size-3 shrink-0", iconClass)} />
        <span className="truncate">{label}</span>
      </div>
      <IconButton
        aria-label={`Show ${label}`}
        label="Show worktree"
        size="icon-xs"
        variant="ghost"
        onClick={onUnhide}
      >
        <EyeOff />
      </IconButton>
    </div>
  );
}
