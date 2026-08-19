import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";

import { Icon } from "@iconify/react";
import { constants, type EditorLauncher, type ShellProfile, type Tab } from "@pragma/constants";
import {
  ArrowLeft,
  ChevronDown,
  Columns2,
  Globe,
  LayoutGrid,
  Pencil,
  Hammer,
  Play,
  Rows2,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton, IconTooltip } from "@/components/ui/icon-button";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentsMenu } from "@/components/agents/AgentsMenu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PlusCloseIcon } from "@/components/ui/plus-close-icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirmClose, useConfirmCloseTabs } from "@/components/editor/confirm-close";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import { TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { TabRenameInput } from "@/components/tabs/TabRenameInput";
import { type TabRenameApi, useTabRename } from "@/components/tabs/use-tab-rename";
import { UsageLimitsPopover } from "@/components/usage-limits/UsageLimitsPopover";
import { ShortcutHint } from "@/components/ShortcutHint";
import { useTerminalSettings } from "@/hooks/use-terminal-settings";
import { useWslDistros } from "@/hooks/use-wsl-distros";
import { FanoutToolbarAction } from "@/components/fanout/FanoutToolbarAction";
import { editorLaunchers } from "@/lib/editor-launchers";
import { isMacPlatform } from "@/lib/platform";
import {
  effectiveDefaultProfile,
  NATIVE_PROFILE,
  sameProfile,
  visibleDistros,
  wslProfile,
} from "@/lib/shell-profile";
import { motionTransition, tabItemVariants } from "@/lib/motion";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { startWindowDrag } from "@/lib/window-drag";
import { useShortcutHint } from "@/lib/shortcut-hints";
import {
  RenderPluginContribution,
  usePluginTopperItems,
  type VisiblePluginContribution,
} from "@/plugins/rendering";
import { useTabAgentStatus } from "@/state/agent-status-store";
import { useKanban } from "@/state/kanban-context";
import { useLeftSidebar } from "@/state/left-sidebar-context";
import {
  type ScriptButtonInfo,
  type SplitDirection,
  type SplitGroupNode,
  type SplitLayoutNode,
  type SplitPaneNode,
  useWorkspace,
} from "@/state/workspace-context";
import type { TopperItemDefinition } from "@pragma/plugin";

const SELECTED_EDITOR_STORAGE_KEY = "pragma.selectedEditorLauncher";
const fallbackEditor =
  editorLaunchers.find((editor) => editor.id === constants.editorLaunchers.defaultEditorId) ??
  editorLaunchers[0]!;

function readSelectedEditorId() {
  try {
    return localStorage.getItem(SELECTED_EDITOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSelectedEditorId(editorId: string) {
  try {
    localStorage.setItem(SELECTED_EDITOR_STORAGE_KEY, editorId);
  } catch {
    // Opening the worktree should still work if storage is unavailable.
  }
}

function editorFor(editorId: string | null): EditorLauncher {
  return editorLaunchers.find((editor) => editor.id === editorId) ?? fallbackEditor;
}

const splitControls: Array<{
  direction: SplitDirection;
  label: string;
  icon: typeof Columns2;
}> = [
  { direction: "horizontal", label: "Split horizontal", icon: Columns2 },
  { direction: "vertical", label: "Split vertical", icon: Rows2 },
];

/** Fallback icon for a script button when it has no `icon` in `.pragma/scripts.json`. */
function fallbackScriptIcon(name: string): typeof Play {
  if (name === "run") return Play;
  if (name === "build") return Hammer;
  return SquareTerminal;
}

function scriptLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function scriptRunLabel(name: string): string {
  if (name === "run") return "Run project scripts";
  if (name === "build") return "Build project scripts";
  return `Run ${scriptLabel(name)}`;
}

function scriptNoneLabel(name: string): string {
  if (name === "run" || name === "build") return `No project ${name} scripts`;
  return `No ${name} scripts configured`;
}

function scriptButtonIcon(button: ScriptButtonInfo, isActive: boolean, IdleIcon: typeof Play) {
  if (isActive) return <Square className="size-3.5" />;
  if (button.icon) return <Icon icon={button.icon} className="size-3.5" />;
  return <IdleIcon className="size-3.5" />;
}

function scriptButtonTooltip({
  button,
  isActive,
  stopping,
  configError,
  runLabel,
}: {
  button: ScriptButtonInfo;
  isActive: boolean;
  stopping: boolean;
  configError: string | null;
  runLabel: string;
}): string {
  if (isActive) return stopping ? "Stopping…" : "Stop project scripts";
  if (configError) return configError;
  if (button.available) return runLabel;
  return scriptNoneLabel(button.name);
}

// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePrSubmit, useWorkspaceListeners); not extractable logic.
function ProjectScriptButton({
  button,
  isActive,
  stopping,
  configError,
  disabled,
  onRun,
  onStop,
}: {
  button: ScriptButtonInfo;
  isActive: boolean;
  stopping: boolean;
  configError: string | null;
  disabled: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const IdleIcon = fallbackScriptIcon(button.name);
  const runLabel = scriptRunLabel(button.name);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            disabled={disabled}
            onClick={() => void (isActive ? onStop() : onRun())}
            size="icon-sm"
            variant={isActive ? "destructive" : "success"}
            aria-label={isActive ? "Stop project scripts" : runLabel}
          >
            {scriptButtonIcon(button, isActive, IdleIcon)}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {scriptButtonTooltip({ button, isActive, stopping, configError, runLabel })}
      </TooltipContent>
    </Tooltip>
  );
}

function findPane(node: SplitLayoutNode, paneId: string): SplitPaneNode | null {
  if (node.kind === "pane") {
    return node.id === paneId ? node : null;
  }
  return findPane(node.children[0], paneId) ?? findPane(node.children[1], paneId);
}

/** The split layout's top-left-most pane — the one the parent tab is named after. */
function leadingPane(node: SplitLayoutNode): SplitPaneNode {
  return node.kind === "pane" ? node : leadingPane(node.children[0]);
}

/** All tab ids that live inside a real split (every pane's tabs). */
function tabIdsInSplit(node: SplitLayoutNode | null | undefined): Set<string> {
  const ids = new Set<string>();
  function visit(item: SplitLayoutNode) {
    if (item.kind === "pane") {
      for (const id of item.tabIds) {
        ids.add(id);
      }
      return;
    }
    visit(item.children[0]);
    visit(item.children[1]);
  }
  if (node?.kind === "split") {
    visit(node);
  }
  return ids;
}

function SplitButton({ direction, label, icon: IconComponent }: (typeof splitControls)[number]) {
  const workspace = useWorkspace();
  const focusedPane = useMemo(() => {
    if (!workspace.splitRoot || !workspace.focusedPaneId) {
      return null;
    }
    return findPane(workspace.splitRoot, workspace.focusedPaneId);
  }, [workspace.splitRoot, workspace.focusedPaneId]);
  const excludedTabId = focusedPane?.activeTabId ?? workspace.activeTabId;
  const candidates = workspace.tabs.filter((tab) => tab.id !== excludedTabId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          disabled={!workspace.activeTabId || candidates.length === 0}
          label={label}
          size="icon-sm"
          variant="ghost"
        >
          <IconComponent />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Split with tab</DropdownMenuLabel>
        <DropdownMenuGroup>
          {candidates.map((tab) => (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => workspace.splitActivePane(tab.id, direction)}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 truncate">{tabTitle(tab)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Workspace = ReturnType<typeof useWorkspace>;

/** Summarize the current split layout: which tabs appear in the top bar. */
function useSplitSummary(workspace: Workspace) {
  const storedSplit = workspace.selectedWorktreeId
    ? (workspace.splitRootByWorktree[workspace.selectedWorktreeId] ?? null)
    : null;
  const split = storedSplit?.kind === "split" ? storedSplit : null;
  const splitTabIds = useMemo(() => tabIdsInSplit(split), [split]);
  const parentTabId = split ? leadingPane(split).activeTabId : null;
  const splitDirection = split?.direction ?? null;
  const splitIsActive = !!workspace.activeTabId && splitTabIds.has(workspace.activeTabId);
  const topTabs = useMemo(
    () => workspace.tabs.filter((tab) => !splitTabIds.has(tab.id) || tab.id === parentTabId),
    [workspace.tabs, splitTabIds, parentTabId],
  );
  const splitTabs = useMemo(
    () => workspace.tabs.filter((tab) => splitTabIds.has(tab.id)),
    [workspace.tabs, splitTabIds],
  );
  return { split, parentTabId, splitDirection, splitIsActive, splitTabs, topTabs };
}

/** The run/build/custom script buttons, rendered wherever the toolbar places them. */
function ProjectScriptButtons({ workspace }: { workspace: Workspace }) {
  return workspace.scriptButtons.map((button) => {
    const active = workspace.activeScripts.find((script) => script.name === button.name);
    return (
      <ProjectScriptButton
        key={button.name}
        button={button}
        isActive={!!active}
        stopping={!!active?.stopping}
        configError={workspace.runScriptsConfigError}
        disabled={computeScriptButtonDisabled(button, workspace)}
        onRun={() => void workspace.runScript(button.name)}
        onStop={() => void workspace.stopScript(button.name)}
      />
    );
  });
}

/** The left side of the toolbar: agents menu, usage limits, go-back. */
function TerminalToolbar({
  workspace,
  topperItems,
}: {
  workspace: Workspace;
  topperItems: VisiblePluginContribution<TopperItemDefinition>[];
}) {
  return (
    // `shrink-0`: the toolbar row scrolls sideways when it runs out of space
    // rather than squeezing its controls into each other.
    <div className="flex shrink-0 items-center gap-1">
      <AgentsMenu />
      <UsageLimitsPopover activeProjectId={workspace.selectedProjectId} />
      <PluginTopperItems items={topperItems} />
      {workspace.agentBackAvailable ? (
        <Button size="sm" variant="ghost" onClick={() => void workspace.goBackFromAgent?.()}>
          <ArrowLeft className="size-3.5" />
          <span className="hidden truncate sm:inline">Go back</span>
        </Button>
      ) : null}
    </div>
  );
}

function PluginTopperItems({
  items,
}: {
  items: VisiblePluginContribution<TopperItemDefinition>[];
}) {
  return items.map((item) => (
    <RenderPluginContribution
      key={item.key}
      component={item.contribution.component}
      config={item.record.config}
      pluginId={item.pluginId}
      resetKey={item.key}
    />
  ));
}

/** Whether a script button is disabled: a script can't be re-run while it's already active. */
function computeScriptButtonDisabled(button: ScriptButtonInfo, workspace: Workspace): boolean {
  const active = workspace.activeScripts.find((script) => script.name === button.name);
  if (active) return active.stopping;
  return !workspace.selectedWorktree || !button.available;
}

/**
 * The single highlight that marks the active tab. It is one element shared
 * across the current tab set via `layoutId`, so activating another tab slides
 * it there. Adding or removing a tab changes the id, preventing a close from
 * animating the highlight onto the fallback tab.
 */
const ACTIVE_TAB_LAYOUT_ID = "terminal-tab-active";

function ActiveTabHighlight({ layoutId }: { layoutId: string }) {
  return (
    <motion.span
      aria-hidden
      className="absolute inset-0 rounded-md border border-border bg-elevated"
      layoutId={layoutId}
      transition={motionTransition.indicator}
    />
  );
}

/** Shared chrome for a top-bar entry: fixed metrics plus the active/idle colouring. */
function tabEntryClassName(active: boolean): string {
  return cn(
    "group relative mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-md border border-transparent px-2 text-sm",
    active ? "text-foreground" : "text-muted-foreground hover:bg-muted",
  );
}

/**
 * The "parent" entry shown in the top bar for a collapsed split. Its X closes
 * the whole split — every tab in every pane — because the split's panes are not
 * individually reachable from this strip.
 */
function SplitParentTab({
  tab,
  splitDirection,
  splitIsActive,
  activeTabLayoutId,
  rename,
  setActiveTab,
  closeSplit,
  shortcutHint,
}: {
  tab: Tab;
  splitDirection: SplitDirection | null;
  splitIsActive: boolean;
  activeTabLayoutId: string;
  rename: TabRenameApi;
  setActiveTab: (id: string) => void;
  closeSplit: () => void;
  shortcutHint: string | null;
}) {
  const displayTitle = tabTitle(tab);
  const ParentIcon = splitDirection === "vertical" ? Rows2 : Columns2;
  const isRenaming = tab.id === rename.renamingTabId;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          animate="visible"
          className={tabEntryClassName(splitIsActive)}
          exit="exit"
          initial="hidden"
          key="split-parent"
          title={`Split: ${displayTitle}`}
          transition={motionTransition.fast}
          variants={tabItemVariants}
        >
          {splitIsActive ? <ActiveTabHighlight layoutId={activeTabLayoutId} /> : null}
          {isRenaming ? (
            <TabRenameInput className="text-sm" rename={rename} />
          ) : (
            <button
              className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.kind === "terminal") terminalManager.focus(tab.id);
              }}
              onDoubleClick={() => rename.startRename(tab.id, displayTitle)}
            >
              <ParentIcon className="text-primary size-3.5 shrink-0" />
              <TabAgentDot tabId={tab.id} />
              <ShortcutHint value={shortcutHint} />
              <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
            </button>
          )}
          <IconTooltip label="Close split">
            <button
              aria-label="Close split"
              className="relative rounded p-0.5 opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
              onClick={closeSplit}
            >
              <X className="size-3" />
            </button>
          </IconTooltip>
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => rename.startRenameFromMenu(tab.id, displayTitle)}>
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={closeSplit}>
          <X />
          Close split
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One regular top-bar tab: drag handle, rename input, close button, context menu. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePrSubmit); not extractable logic.
function TerminalTabItem({
  tab,
  active,
  activeTabLayoutId,
  rename,
  requestClose,
  beginTabDrag,
  endTabDrag,
  setActiveTab,
  shortcutHint,
}: {
  tab: Tab;
  active: boolean;
  activeTabLayoutId: string;
  rename: TabRenameApi;
  requestClose: (tab: Tab) => void;
  beginTabDrag: (tabId: string) => void;
  endTabDrag: () => void;
  setActiveTab: (id: string) => void;
  shortcutHint: string | null;
}) {
  const displayTitle = tabTitle(tab);
  const isRenaming = tab.id === rename.renamingTabId;
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
      event.dataTransfer.effectAllowed = "move";
      beginTabDrag(tab.id);
    },
    [beginTabDrag, tab.id],
  );
  return (
    <ContextMenu key={tab.id}>
      <ContextMenuTrigger asChild>
        {/* The HTML5 drag handlers stay on a plain wrapper: a motion component
            replaces `onDragStart`/`onDragEnd` with its own pan-gesture
            signatures, which are not the native DragEvent this uses. */}
        <div className="shrink-0" draggable onDragStart={handleDragStart} onDragEnd={endTabDrag}>
          <motion.div
            animate="visible"
            className={tabEntryClassName(active)}
            exit="exit"
            initial="hidden"
            transition={motionTransition.fast}
            variants={tabItemVariants}
          >
            {active ? <ActiveTabHighlight layoutId={activeTabLayoutId} /> : null}
            {isRenaming ? (
              <TabRenameInput className="text-sm" rename={rename} />
            ) : (
              <button
                className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.kind === "terminal") terminalManager.focus(tab.id);
                }}
                onDoubleClick={() => rename.startRename(tab.id, displayTitle)}
              >
                <TabIcon tab={tab} />
                <TabAgentDot tabId={tab.id} />
                <ShortcutHint value={shortcutHint} />
                <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
              </button>
            )}
            <TabDirtyDot tabId={tab.id} />
            <IconTooltip label="Close tab">
              <button
                aria-label="Close tab"
                className="relative rounded p-0.5 opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
                onClick={() => requestClose(tab)}
              >
                <X className="size-3" />
              </button>
            </IconTooltip>
          </motion.div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => rename.startRenameFromMenu(tab.id, displayTitle)}>
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => requestClose(tab)}>
          <X />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type TerminalTabEntryProps = {
  tab: Tab;
  active: boolean;
  activeTabLayoutId: string;
  split: SplitGroupNode | null;
  parentTabId: string | null;
  splitDirection: SplitDirection | null;
  splitIsActive: boolean;
  closeSplit: () => void;
  rename: TabRenameApi;
  requestClose: (tab: Tab) => void;
  beginTabDrag: (tabId: string) => void;
  endTabDrag: () => void;
  setActiveTab: (id: string) => void;
  shortcutIndex: number | null;
};

/** Renders one top-bar entry: a split parent (if applicable) or a regular tab. */
function TerminalTabEntry(props: TerminalTabEntryProps) {
  const { parentTabId, split, tab } = props;
  const shortcutHint = useShortcutHint("tab", props.shortcutIndex);
  if (split && tab.id === parentTabId) {
    return (
      <SplitParentTab
        activeTabLayoutId={props.activeTabLayoutId}
        closeSplit={props.closeSplit}
        rename={props.rename}
        setActiveTab={props.setActiveTab}
        splitDirection={props.splitDirection}
        splitIsActive={props.splitIsActive}
        shortcutHint={shortcutHint}
        tab={tab}
      />
    );
  }
  return (
    <TerminalTabItem
      active={props.active}
      activeTabLayoutId={props.activeTabLayoutId}
      beginTabDrag={props.beginTabDrag}
      endTabDrag={props.endTabDrag}
      rename={props.rename}
      requestClose={props.requestClose}
      setActiveTab={props.setActiveTab}
      shortcutHint={shortcutHint}
      tab={tab}
    />
  );
}

/** The "open worktree in editor" split button + editor chooser dropdown. */
function EditorLauncherMenu({
  selectedEditor,
  disabled,
  onSelect,
}: {
  selectedEditor: EditorLauncher;
  disabled: boolean;
  onSelect: (editor: EditorLauncher) => void;
}) {
  return (
    <DropdownMenu>
      <div className="flex shrink-0 items-center">
        <Button
          className="max-w-44 rounded-r-none"
          disabled={disabled}
          onClick={() => onSelect(selectedEditor)}
          size="sm"
          variant="outline"
          aria-label={`Open worktree in ${selectedEditor.name}`}
        >
          <Icon
            className="size-3.5 shrink-0"
            icon={selectedEditor.brandIcon}
            style={{ color: selectedEditor.brandColor }}
          />
          <span className="hidden truncate sm:inline">{selectedEditor.name}</span>
        </Button>
        <DropdownMenuTrigger asChild>
          <IconButton
            className="rounded-l-none border-l border-l-border px-1"
            disabled={disabled}
            label="Choose editor"
            size="icon-sm"
            variant="outline"
          >
            <ChevronDown className="size-4 opacity-70" />
          </IconButton>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="min-w-48">
        {editorLaunchers.map((editor) => (
          <DropdownMenuItem key={editor.id} onSelect={() => onSelect(editor)}>
            <Icon className="size-4" icon={editor.brandIcon} style={{ color: editor.brandColor }} />
            {editor.name}
            {editor.id === selectedEditor.id ? (
              <DropdownMenuShortcut>Default</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Label for the host's own shell in the shell submenu. The submenu only renders
 * when the worktree's host reports WSL distributions, which makes it a Windows
 * host, so naming PowerShell here is accurate rather than a guess.
 */
const NATIVE_SHELL_LABEL = "PowerShell";

/**
 * The agent-board toggle, between the script buttons and the editor
 * controls. It is a labelled `outline` button so it reads as a peer of the
 * "open in editor" control next to it, not as one more icon-only affordance.
 */
function KanbanToggle() {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const active = kanban.mode === "kanban";
  return (
    <Button
      aria-label="Toggle agent board"
      aria-pressed={active}
      className="shrink-0 text-foreground"
      disabled={!workspace.selectedProjectId}
      size="sm"
      variant={active ? "secondary" : "outline"}
      onClick={() => (active ? kanban.exitBoard() : kanban.openBoard())}
    >
      <LayoutGrid className="size-3.5 shrink-0" />
      <span className="hidden truncate sm:inline">Board</span>
    </Button>
  );
}

/**
 * The "new tab" dropdown for creating a terminal or browser tab.
 *
 * `worktreeId` scopes the distribution list to the host the new tab would spawn
 * on. For a project opened over SSH that is the remote daemon's machine, whose
 * distributions are the only ones it can actually launch.
 */
function NewTabMenu({
  shortcutModifier,
  disabled,
  projectId,
  worktreeId,
  onCreateTerminal,
  onCreateBrowser,
}: {
  shortcutModifier: string;
  disabled: boolean;
  projectId: string | null;
  worktreeId: string | null;
  onCreateTerminal: (shell?: ShellProfile | null) => void;
  onCreateBrowser: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wsl = useWslDistros(worktreeId);
  // "Default" here means the shell Settings → Terminal selected — the one a
  // plain ⌘T opens — not the distribution WSL itself marks as its default.
  const { defaultProfile, hiddenDistros } = useTerminalSettings(projectId);
  const distros = visibleDistros(wsl.distros, hiddenDistros);
  const resolvedDefault = effectiveDefaultProfile(defaultProfile ?? NATIVE_PROFILE, distros);
  const defaultBadge = (profile: ShellProfile) =>
    sameProfile(resolvedDefault, profile) ? (
      <DropdownMenuShortcut>Default</DropdownMenuShortcut>
    ) : null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          className="mr-2"
          disabled={disabled}
          label="New tab"
          size="icon-sm"
          // The menu itself explains the choice once it is open.
          tooltipDisabled={open}
          variant="ghost"
        >
          <PlusCloseIcon open={open} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* With no distributions to choose between there is nothing to nest, so
            Terminal stays a plain item rather than a submenu of one. */}
        {distros.length === 0 ? (
          <DropdownMenuItem onSelect={() => onCreateTerminal()}>
            <SquareTerminal />
            Terminal
            <DropdownMenuShortcut>{shortcutModifier}T</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquareTerminal />
              Terminal
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              <DropdownMenuItem onSelect={() => onCreateTerminal(NATIVE_PROFILE)}>
                <SquareTerminal />
                {NATIVE_SHELL_LABEL}
                {defaultBadge(NATIVE_PROFILE)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>WSL</DropdownMenuLabel>
              {distros.map((distro) => (
                <DropdownMenuItem
                  key={distro.name}
                  onSelect={() => onCreateTerminal(wslProfile(distro.name))}
                >
                  <Icon className="size-4" icon="simple-icons:linux" />
                  {distro.name}
                  {defaultBadge(wslProfile(distro.name))}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem onSelect={onCreateBrowser}>
          <Globe />
          Browser
          <DropdownMenuShortcut>{shortcutModifier}B</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TerminalTabs() {
  const workspace = useWorkspace();
  const requestClose = useConfirmClose();
  const requestCloseTabs = useConfirmCloseTabs();
  const { beginTabDrag, endTabDrag } = useTabDrag();
  const [selectedEditorId, setSelectedEditorId] = useState(readSelectedEditorId);
  const rename = useTabRename();
  const { split, parentTabId, splitDirection, splitIsActive, splitTabs, topTabs } =
    useSplitSummary(workspace);
  const closeSplit = useCallback(() => requestCloseTabs(splitTabs), [requestCloseTabs, splitTabs]);
  const selectedEditor = editorFor(selectedEditorId);
  const editorDisabled =
    !workspace.selectedWorktree ||
    workspace.remoteWorktrees[workspace.selectedWorktree.id] === true;

  const openEditor = useCallback(
    (editor: EditorLauncher) => {
      setSelectedEditorId(editor.id);
      writeSelectedEditorId(editor.id);
      void workspace.openSelectedWorktree(editor.id);
    },
    [workspace],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <header className="text-muted-foreground bg-sidebar flex shrink-0 flex-col">
        <TerminalTabsToolbar
          editorDisabled={editorDisabled}
          onOpenEditor={openEditor}
          selectedEditor={selectedEditor}
          workspace={workspace}
        />
        <TerminalTabStrip
          beginTabDrag={beginTabDrag}
          closeSplit={closeSplit}
          endTabDrag={endTabDrag}
          parentTabId={parentTabId}
          rename={rename}
          requestClose={requestClose}
          split={split}
          splitDirection={splitDirection}
          splitIsActive={splitIsActive}
          topTabs={topTabs}
          workspace={workspace}
        />
      </header>
    </TooltipProvider>
  );
}

function TerminalTabsToolbar({
  editorDisabled,
  onOpenEditor,
  selectedEditor,
  workspace,
}: {
  editorDisabled: boolean;
  onOpenEditor: (editor: EditorLauncher) => void;
  selectedEditor: EditorLauncher;
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const leftTopperItems = usePluginTopperItems(workspace.selectedProjectId, "left");
  const rightTopperItems = usePluginTopperItems(workspace.selectedProjectId, "right");
  const { collapsed: leftSidebarCollapsed } = useLeftSidebar();
  const clearTrafficLights = leftSidebarCollapsed && isMacPlatform();
  return (
    // The toolbar doubles as the window drag handle on the content side.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent
    <div
      className={cn(
        "flex h-9 items-center border-b border-sidebar-border px-2",
        clearTrafficLights && "pl-16",
      )}
      onMouseDown={startWindowDrag}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        <TerminalToolbar topperItems={leftTopperItems} workspace={workspace} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <PluginTopperItems items={rightTopperItems} />
          <ProjectScriptButtons workspace={workspace} />
          <KanbanToggle />
          <FanoutToolbarAction />
          <EditorLauncherMenu
            disabled={editorDisabled}
            onSelect={onOpenEditor}
            selectedEditor={selectedEditor}
          />
        </div>
      </div>
    </div>
  );
}

function TerminalTabStrip({
  beginTabDrag,
  closeSplit,
  endTabDrag,
  parentTabId,
  rename,
  requestClose,
  split,
  splitDirection,
  splitIsActive,
  topTabs,
  workspace,
}: Omit<
  TerminalTabEntryProps,
  "active" | "activeTabLayoutId" | "setActiveTab" | "shortcutIndex" | "tab"
> & {
  topTabs: Tab[];
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const shortcutModifier = isMacPlatform() ? "⌘" : "Ctrl+";
  const activeTabLayoutId = `${ACTIVE_TAB_LAYOUT_ID}:${topTabs.map((tab) => tab.id).join(",")}`;
  return (
    <div className="bg-canvas flex h-11 items-center">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
        <LayoutGroup id={workspace.selectedWorktreeId ?? "no-worktree"}>
          <AnimatePresence initial={false} key={workspace.selectedWorktreeId ?? "no-worktree"}>
            {topTabs.map((tab) => (
              <TerminalTabEntry
                active={tab.id === workspace.activeTabId}
                activeTabLayoutId={activeTabLayoutId}
                beginTabDrag={beginTabDrag}
                closeSplit={closeSplit}
                endTabDrag={endTabDrag}
                key={tab.id}
                parentTabId={parentTabId}
                rename={rename}
                requestClose={requestClose}
                setActiveTab={workspace.setActiveTab}
                shortcutIndex={
                  workspace.tabs.indexOf(tab) < 9 ? workspace.tabs.indexOf(tab) + 1 : null
                }
                split={split}
                splitDirection={splitDirection}
                splitIsActive={splitIsActive}
                tab={tab}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>
      <div className="mr-1 flex shrink-0 items-center gap-1">
        {splitControls.map((control) => (
          <SplitButton key={control.direction} {...control} />
        ))}
      </div>
      <NewTabMenu
        disabled={!workspace.selectedWorktree}
        onCreateBrowser={() => void workspace.createBrowserTab()}
        onCreateTerminal={(shell) =>
          void workspace.createTerminalTab(undefined, shell === undefined ? undefined : { shell })
        }
        projectId={workspace.selectedProjectId}
        shortcutModifier={shortcutModifier}
        worktreeId={workspace.selectedWorktree?.id ?? null}
      />
    </div>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  // `relative` keeps the dot above the absolutely-positioned active highlight.
  return <AgentStatusDot className="relative" status={useTabAgentStatus(tabId)} />;
}
