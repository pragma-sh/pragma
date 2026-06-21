import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { constants, type EditorLauncher } from "@pragma/constants";
import {
  ArrowLeft,
  ChevronDown,
  Columns2,
  Globe,
  Pencil,
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
import { isMacPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";
import {
  type SplitDirection,
  type SplitLayoutNode,
  type SplitPaneNode,
  useWorkspace,
} from "@/state/workspace-context";

const SELECTED_EDITOR_STORAGE_KEY = "pragma.selectedEditorLauncher";
const editorLaunchers = constants.editorLaunchers.options;
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
              className="text-slate-200 hover:bg-white/10 hover:text-white"
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

export function TerminalTabs() {
  const workspace = useWorkspace();
  const requestClose = useConfirmClose();
  const { beginTabDrag, endTabDrag } = useTabDrag();
  const [selectedEditorId, setSelectedEditorId] = useState(readSelectedEditorId);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shortcutModifier = isMacPlatform() ? "⌘" : "Ctrl+";
  const selectedEditor = editorFor(selectedEditorId);
  const runState = workspace.runScriptsState;
  const runDisabled = runState
    ? runState.stopping
    : !workspace.selectedWorktree || !workspace.runScriptsAvailable;

  // A split collapses into a single "parent" entry in the top bar, named after
  // its top-left pane. Its members are hidden from the bar (they live in the
  // pane bars); every other tab stays a normal top-bar tab.
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

  const cancelRename = useCallback(() => {
    setRenamingTabId(null);
  }, []);

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
      <header className="flex shrink-0 flex-col border-b border-white/10 bg-[#11151b] text-slate-300">
        <div className="flex h-9 items-center justify-between gap-2 border-b border-white/5 bg-[#151b24] px-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.03)]">
          <div className="flex min-w-0 items-center gap-1">
            <AgentsMenu />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={cn(
                    "border shadow-sm hover:text-white",
                    runState
                      ? "border-rose-400/30 bg-rose-400/12 text-rose-50 shadow-rose-950/30 hover:bg-rose-400/20"
                      : "border-emerald-400/25 bg-emerald-400/12 text-emerald-50 shadow-emerald-950/30 hover:bg-emerald-400/20",
                  )}
                  disabled={runDisabled}
                  onClick={() =>
                    void (runState ? workspace.stopRunScripts() : workspace.runScripts())
                  }
                  size="icon-sm"
                  variant="ghost"
                  aria-label={runState ? "Stop project scripts" : "Run project scripts"}
                >
                  {runState ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {runState
                  ? "Stop project scripts"
                  : workspace.runScriptsAvailable
                    ? "Run project scripts"
                    : "No project run scripts"}
              </TooltipContent>
            </Tooltip>
            {workspace.agentBackAvailable ? (
              <Button
                className="text-slate-200 hover:bg-white/10 hover:text-white"
                size="sm"
                variant="ghost"
                onClick={() => void workspace.goBackFromAgent?.()}
              >
                <ArrowLeft className="size-3.5" />
                <span className="hidden sm:inline">Go back</span>
              </Button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-end">
            <DropdownMenu>
              <div className="flex shrink-0 items-center">
                <Button
                  className="max-w-44 rounded-r-none border border-cyan-400/25 bg-cyan-400/12 text-cyan-50 shadow-sm shadow-cyan-950/30 hover:bg-cyan-400/20 hover:text-white"
                  disabled={!workspace.selectedWorktree}
                  onClick={() => openEditor(selectedEditor)}
                  size="sm"
                  variant="ghost"
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
                    className="rounded-l-none border border-l-0 border-cyan-400/25 bg-cyan-400/12 px-1 text-cyan-50 shadow-sm shadow-cyan-950/30 hover:bg-cyan-400/20 hover:text-white"
                    disabled={!workspace.selectedWorktree}
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Choose editor"
                  >
                    <ChevronDown className="size-3 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
              </div>
              <DropdownMenuContent align="end" className="min-w-48">
                {editorLaunchers.map((editor) => (
                  <DropdownMenuItem key={editor.id} onSelect={() => openEditor(editor)}>
                    <Icon
                      className="size-4"
                      icon={editor.brandIcon}
                      style={{ color: editor.brandColor }}
                    />
                    {editor.name}
                    {editor.id === selectedEditor.id ? (
                      <DropdownMenuShortcut>Default</DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex h-11 items-center">
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
            {topTabs.map((tab) => {
              const displayTitle = tabTitle(tab);
              if (split && tab.id === parentTabId) {
                const ParentIcon = splitDirection === "vertical" ? Rows2 : Columns2;
                return (
                  <button
                    className={cn(
                      "group mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-lg border px-2 text-sm",
                      splitIsActive
                        ? "border-slate-600 bg-slate-800 text-white"
                        : "border-transparent bg-transparent hover:bg-slate-900",
                    )}
                    key="split-parent"
                    onClick={() => workspace.setActiveTab(tab.id)}
                    title={`Split: ${displayTitle}`}
                  >
                    <ParentIcon className="size-3.5 shrink-0 text-cyan-300" />
                    <TabAgentDot tabId={tab.id} />
                    <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
                  </button>
                );
              }
              const active = tab.id === workspace.activeTabId;
              const isRenaming = tab.id === renamingTabId;
              return (
                <ContextMenu key={tab.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "group mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-lg border px-2 text-sm",
                        active
                          ? "border-slate-600 bg-slate-800 text-white"
                          : "border-transparent bg-transparent hover:bg-slate-900",
                      )}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
                        event.dataTransfer.effectAllowed = "move";
                        beginTabDrag(tab.id);
                      }}
                      onDragEnd={endTabDrag}
                    >
                      {isRenaming ? (
                        <input
                          ref={inputRef}
                          aria-label="Rename tab"
                          className="w-0 min-w-0 flex-1 rounded bg-white/10 px-1 text-left text-sm text-white outline-none ring-1 ring-slate-500"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          onBlur={commitRename}
                        />
                      ) : (
                        <button
                          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                          onClick={() => workspace.setActiveTab(tab.id)}
                          onDoubleClick={() => startRename(tab.id, displayTitle)}
                        >
                          <TabIcon tab={tab} />
                          <TabAgentDot tabId={tab.id} />
                          <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                        </button>
                      )}
                      <TabDirtyDot tabId={tab.id} />
                      <button
                        aria-label="Close tab"
                        className="rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
                        onClick={() => requestClose(tab)}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => startRename(tab.id, displayTitle)}>
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
            })}
          </div>
          <div className="mr-1 flex shrink-0 items-center gap-1">
            {splitControls.map((control) => (
              <SplitButton key={control.direction} {...control} />
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="mr-2 text-slate-200 hover:bg-white/10 hover:text-white"
                disabled={!workspace.selectedWorktree}
                size="icon-sm"
                variant="ghost"
                aria-label="New tab"
              >
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void workspace.createTerminalTab()}>
                <SquareTerminal />
                Terminal
                <DropdownMenuShortcut>{shortcutModifier}T</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void workspace.createBrowserTab()}>
                <Globe />
                Browser
                <DropdownMenuShortcut>{shortcutModifier}B</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    </TooltipProvider>
  );
}

function TabAgentDot({ tabId }: { tabId: string }) {
  return <AgentStatusDot status={useTabAgentStatus(tabId)} />;
}
