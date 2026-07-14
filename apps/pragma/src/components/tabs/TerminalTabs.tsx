import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { constants, type EditorLauncher, type Tab } from "@pragma/constants";
import {
  ArrowLeft,
  ChevronDown,
  Columns2,
  Globe,
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirmClose } from "@/components/editor/confirm-close";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import { TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { UsageLimitsPopover } from "@/components/usage-limits/UsageLimitsPopover";
import { editorLaunchers } from "@/lib/editor-launchers";
import { isMacPlatform } from "@/lib/platform";
import { commitOnEnterCancelOnEscape } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { startWindowDrag } from "@/lib/window-drag";
import {
  RenderPluginContribution,
  usePluginTopperItems,
  type VisiblePluginContribution,
} from "@/plugins/rendering";
import { useTabAgentStatus } from "@/state/agent-status-store";
import {
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

function ProjectScriptButton({
  activeState,
  available,
  configError,
  disabled,
  idleIcon: IdleIcon,
  labels,
  onRun,
  onStop,
}: {
  activeState: ReturnType<typeof useWorkspace>["runScriptsState"];
  available: boolean;
  configError: string | null;
  disabled: boolean;
  idleIcon: typeof Play;
  labels: { run: string; stop: string; none: string };
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            disabled={disabled}
            onClick={() => void (activeState ? onStop() : onRun())}
            size="icon-sm"
            variant={activeState ? "destructive" : "success"}
            aria-label={activeState ? labels.stop : labels.run}
          >
            {activeState ? <Square className="size-3.5" /> : <IdleIcon className="size-3.5" />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {activeState
          ? labels.stop
          : configError
            ? configError
            : available
              ? labels.run
              : labels.none}
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

/** The left side of the toolbar: agents menu, run/build script buttons, go-back. */
function TerminalToolbar({
  workspace,
  runDisabled,
  buildDisabled,
  topperItems,
}: {
  workspace: Workspace;
  runDisabled: boolean;
  buildDisabled: boolean;
  topperItems: VisiblePluginContribution<TopperItemDefinition>[];
}) {
  const runState = workspace.runScriptsState;
  const buildState = workspace.buildScriptsState;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <AgentsMenu />
      <ProjectScriptButton
        activeState={runState}
        available={workspace.runScriptsAvailable}
        configError={workspace.runScriptsConfigError}
        disabled={runDisabled}
        idleIcon={Play}
        labels={{
          run: "Run project scripts",
          stop: "Stop project scripts",
          none: "No project run scripts",
        }}
        onRun={() => void workspace.runScripts()}
        onStop={() => void workspace.stopRunScripts()}
      />
      <ProjectScriptButton
        activeState={buildState}
        available={workspace.buildScriptsAvailable}
        configError={workspace.runScriptsConfigError}
        disabled={buildDisabled}
        idleIcon={Hammer}
        labels={{
          run: "Build project scripts",
          stop: "Stop project scripts",
          none: "No project build scripts",
        }}
        onRun={() => void workspace.buildScripts()}
        onStop={() => void workspace.stopBuildScripts()}
      />
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

/** Whether the "Run" project-script button is disabled given current run/build state. */
function computeRunDisabled(
  runState: Workspace["runScriptsState"],
  buildState: Workspace["buildScriptsState"],
  workspace: Workspace,
): boolean {
  if (runState) return runState.stopping;
  return !workspace.selectedWorktree || !workspace.runScriptsAvailable || !!buildState;
}

/** Whether the "Build" project-script button is disabled given current build/run state. */
function computeBuildDisabled(
  buildState: Workspace["buildScriptsState"],
  runState: Workspace["runScriptsState"],
  workspace: Workspace,
): boolean {
  if (buildState) return buildState.stopping;
  return !workspace.selectedWorktree || !workspace.buildScriptsAvailable || !!runState;
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
      onClick={() => setActiveTab(tab.id)}
      title={`Split: ${displayTitle}`}
    >
      <ParentIcon className="text-primary size-3.5 shrink-0" />
      <TabAgentDot tabId={tab.id} />
      <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
    </button>
  );
}

/** One regular top-bar tab: drag handle, rename input, close button, context menu. */
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
              onClick={() => setActiveTab(tab.id)}
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

/** The "new tab" dropdown for creating a terminal or browser tab. */
function NewTabMenu({
  shortcutModifier,
  disabled,
  onCreateTerminal,
  onCreateBrowser,
}: {
  shortcutModifier: string;
  disabled: boolean;
  onCreateTerminal: () => void;
  onCreateBrowser: () => void;
}) {
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
        <DropdownMenuItem onSelect={onCreateTerminal}>
          <SquareTerminal />
          Terminal
          <DropdownMenuShortcut>{shortcutModifier}T</DropdownMenuShortcut>
        </DropdownMenuItem>
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
  const runDisabled = computeRunDisabled(
    workspace.runScriptsState,
    workspace.buildScriptsState,
    workspace,
  );
  const buildDisabled = computeBuildDisabled(
    workspace.buildScriptsState,
    workspace.runScriptsState,
    workspace,
  );

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
          <TerminalToolbar
            buildDisabled={buildDisabled}
            topperItems={leftTopperItems}
            runDisabled={runDisabled}
            workspace={workspace}
          />
          <div className="flex shrink-0 items-center justify-end gap-1">
            <PluginTopperItems items={rightTopperItems} />
            <UsageLimitsPopover activeProjectId={workspace.selectedProjectId} />
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
            onCreateTerminal={() => void workspace.createTerminalTab()}
            shortcutModifier={shortcutModifier}
          />
        </div>
      </header>
    </TooltipProvider>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  return <AgentStatusDot status={useTabAgentStatus(tabId)} />;
}
