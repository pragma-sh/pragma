import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  Plus,
  Rows2,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirmClose } from "@/components/editor/confirm-close";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import { TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { UsageLimitsPopover } from "@/components/usage-limits/UsageLimitsPopover";
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
import { commitOnEnterCancelOnEscape } from "@/lib/keyboard";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { startWindowDrag } from "@/lib/window-drag";
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
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              disabled={!workspace.activeTabId || candidates.length === 0}
              size="icon-sm"
              variant="ghost"
              aria-label={label}
            >
              <IconComponent />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
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
  return { split, parentTabId, splitDirection, splitIsActive, topTabs };
}

/** The left side of the toolbar: agents menu, run/build/custom script buttons, go-back. */
function TerminalToolbar({
  workspace,
  topperItems,
}: {
  workspace: Workspace;
  topperItems: VisiblePluginContribution<TopperItemDefinition>[];
}) {
  // With the project sidebar collapsed on macOS, the inset traffic lights
  // (x-inset 12 + three ~14px buttons) sit over the toolbar's left edge — pad
  // past them so the first control stays clickable.
  const { collapsed: sidebarCollapsed } = useLeftSidebar();
  const clearTrafficLights = sidebarCollapsed && isMacPlatform();
  return (
    <div className={cn("flex min-w-0 items-center gap-1", clearTrafficLights && "pl-16")}>
      <AgentsMenu />
      {workspace.scriptButtons.map((button) => {
        const active = workspace.activeScripts.find((script) => script.name === button.name);
        const disabled = computeScriptButtonDisabled(button, workspace);
        return (
          <ProjectScriptButton
            key={button.name}
            button={button}
            isActive={!!active}
            stopping={!!active?.stopping}
            configError={workspace.runScriptsConfigError}
            disabled={disabled}
            onRun={() => void workspace.runScript(button.name)}
            onStop={() => void workspace.stopScript(button.name)}
          />
        );
      })}
      <PluginTopperItems items={topperItems} />
      {workspace.agentBackAvailable ? (
        <Button size="sm" variant="ghost" onClick={() => void workspace.goBackFromAgent?.()}>
          <ArrowLeft className="size-3.5" />
          <span className="hidden sm:inline">Go back</span>
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

/** Shared inline-rename state for terminal tabs (only one tab renames at a time). */
function useTabRename(workspace: Workspace): {
  renamingTabId: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  startRename: (tabId: string, currentTitle: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
} {
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingTabId]);
  const startRename = useCallback((tabId: string, currentTitle: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentTitle);
  }, []);
  const commitRename = useCallback(() => {
    if (renamingTabId && renameValue.trim()) {
      void workspace.renameTerminalTab(renamingTabId, renameValue.trim());
    }
    setRenamingTabId(null);
  }, [renamingTabId, renameValue, workspace]);
  const cancelRename = useCallback(() => setRenamingTabId(null), []);
  return {
    renamingTabId,
    renameValue,
    setRenameValue,
    inputRef,
    startRename,
    commitRename,
    cancelRename,
  };
}

type TabRenameApi = ReturnType<typeof useTabRename>;

/** The "parent" entry shown in the top bar for a collapsed split. */
function SplitParentTab({
  tab,
  splitDirection,
  splitIsActive,
  setActiveTab,
}: {
  tab: Tab;
  splitDirection: SplitDirection | null;
  splitIsActive: boolean;
  setActiveTab: (id: string) => void;
}) {
  const displayTitle = tabTitle(tab);
  const ParentIcon = splitDirection === "vertical" ? Rows2 : Columns2;
  return (
    <button
      className={cn(
        "group mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-md border px-2 text-sm",
        splitIsActive
          ? "border-border bg-elevated text-foreground"
          : "text-muted-foreground border-transparent bg-transparent hover:bg-muted",
      )}
      key="split-parent"
      onClick={() => {
        setActiveTab(tab.id);
        if (tab.kind === "terminal") terminalManager.focus(tab.id);
      }}
      title={`Split: ${displayTitle}`}
    >
      <ParentIcon className="text-primary size-3.5 shrink-0" />
      <TabAgentDot tabId={tab.id} />
      <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
    </button>
  );
}

/** One regular top-bar tab: drag handle, rename input, close button, context menu. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePrSubmit); not extractable logic.
function TerminalTabItem({
  tab,
  active,
  rename,
  requestClose,
  beginTabDrag,
  endTabDrag,
  setActiveTab,
}: {
  tab: Tab;
  active: boolean;
  rename: TabRenameApi;
  requestClose: (tab: Tab) => void;
  beginTabDrag: (tabId: string) => void;
  endTabDrag: () => void;
  setActiveTab: (id: string) => void;
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
        <div
          className={cn(
            "group mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-md border px-2 text-sm",
            active
              ? "border-border bg-elevated text-foreground"
              : "text-muted-foreground border-transparent bg-transparent hover:bg-muted",
          )}
          draggable
          onDragStart={handleDragStart}
          onDragEnd={endTabDrag}
        >
          {isRenaming ? (
            <input
              ref={rename.inputRef}
              aria-label="Rename tab"
              className="text-foreground ring-ring w-0 min-w-0 flex-1 rounded bg-muted px-1 text-left text-sm outline-none ring-1"
              value={rename.renameValue}
              onChange={(e) => rename.setRenameValue(e.target.value)}
              onKeyDown={commitOnEnterCancelOnEscape(rename.commitRename, rename.cancelRename)}
              onBlur={rename.commitRename}
            />
          ) : (
            <button
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.kind === "terminal") terminalManager.focus(tab.id);
              }}
              onDoubleClick={() => rename.startRename(tab.id, displayTitle)}
            >
              <TabIcon tab={tab} />
              <TabAgentDot tabId={tab.id} />
              <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
            </button>
          )}
          <TabDirtyDot tabId={tab.id} />
          <button
            aria-label="Close tab"
            className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
            onClick={() => requestClose(tab)}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => rename.startRename(tab.id, displayTitle)}>
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

/** Renders one top-bar entry: a split parent (if applicable) or a regular tab. */
// fallow-ignore-next-line code-duplication
function TerminalTabEntry({
  tab,
  active,
  split,
  parentTabId,
  splitDirection,
  splitIsActive,
  rename,
  requestClose,
  beginTabDrag,
  endTabDrag,
  setActiveTab,
}: {
  tab: Tab;
  active: boolean;
  split: SplitGroupNode | null;
  parentTabId: string | null;
  splitDirection: SplitDirection | null;
  splitIsActive: boolean;
  rename: TabRenameApi;
  requestClose: (tab: Tab) => void;
  beginTabDrag: (tabId: string) => void;
  endTabDrag: () => void;
  setActiveTab: (id: string) => void;
}) {
  if (split && tab.id === parentTabId) {
    return (
      <SplitParentTab
        setActiveTab={setActiveTab}
        splitDirection={splitDirection}
        splitIsActive={splitIsActive}
        tab={tab}
      />
    );
  }
  return (
    <TerminalTabItem
      active={active}
      beginTabDrag={beginTabDrag}
      endTabDrag={endTabDrag}
      rename={rename}
      requestClose={requestClose}
      setActiveTab={setActiveTab}
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
          <Button
            className="rounded-l-none border-l border-l-border px-1"
            disabled={disabled}
            size="icon-sm"
            variant="outline"
            aria-label="Choose editor"
          >
            <ChevronDown className="size-4 opacity-70" />
          </Button>
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

/** The prompt-board (Kanban) toggle, between the usage-limits and editor controls. */
function KanbanToggle() {
  const kanban = useKanban();
  const workspace = useWorkspace();
  return (
    <Button
      aria-label="Toggle prompt board"
      aria-pressed={kanban.mode === "kanban"}
      disabled={!workspace.selectedProjectId}
      size="icon-sm"
      variant={kanban.mode === "kanban" ? "secondary" : "ghost"}
      onClick={() => (kanban.mode === "kanban" ? kanban.exitBoard() : kanban.openBoard())}
    >
      <LayoutGrid />
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="mr-2"
          disabled={disabled}
          size="icon-sm"
          variant="ghost"
          aria-label="New tab"
        >
          <Plus />
        </Button>
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
  const { beginTabDrag, endTabDrag } = useTabDrag();
  const [selectedEditorId, setSelectedEditorId] = useState(readSelectedEditorId);
  const rename = useTabRename(workspace);
  const { split, parentTabId, splitDirection, splitIsActive, topTabs } = useSplitSummary(workspace);
  const leftTopperItems = usePluginTopperItems(workspace.selectedProjectId, "left");
  const rightTopperItems = usePluginTopperItems(workspace.selectedProjectId, "right");
  const shortcutModifier = isMacPlatform() ? "⌘" : "Ctrl+";
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
        {/* The toolbar doubles as the window drag handle on the content side. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent */}
        <div
          className="flex h-9 items-center justify-between gap-2 border-b border-sidebar-border px-2"
          onMouseDown={startWindowDrag}
        >
          <TerminalToolbar topperItems={leftTopperItems} workspace={workspace} />
          <div className="flex shrink-0 items-center justify-end gap-1">
            <PluginTopperItems items={rightTopperItems} />
            <UsageLimitsPopover activeProjectId={workspace.selectedProjectId} />
            <KanbanToggle />
            <FanoutToolbarAction />
            <EditorLauncherMenu
              disabled={editorDisabled}
              onSelect={openEditor}
              selectedEditor={selectedEditor}
            />
          </div>
        </div>
        <div className="bg-canvas flex h-11 items-center">
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
            {topTabs.map((tab) => (
              <TerminalTabEntry
                key={tab.id}
                active={tab.id === workspace.activeTabId}
                beginTabDrag={beginTabDrag}
                endTabDrag={endTabDrag}
                parentTabId={parentTabId}
                rename={rename}
                requestClose={requestClose}
                setActiveTab={workspace.setActiveTab}
                split={split}
                splitDirection={splitDirection}
                splitIsActive={splitIsActive}
                tab={tab}
              />
            ))}
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
              void workspace.createTerminalTab(
                undefined,
                shell === undefined ? undefined : { shell },
              )
            }
            projectId={workspace.selectedProjectId}
            shortcutModifier={shortcutModifier}
            worktreeId={workspace.selectedWorktree?.id ?? null}
          />
        </div>
      </header>
    </TooltipProvider>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  return <AgentStatusDot status={useTabAgentStatus(tabId)} />;
}
