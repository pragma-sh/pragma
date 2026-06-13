import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { constants, type EditorLauncher } from "@pragma/constants";
import { ChevronDown, Globe, Pencil, Plus, SquareTerminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMacPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

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

/** Renders a browser tab's favicon, falling back to a globe glyph on error. */
function BrowserTabIcon({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  const favicon = useMemo(() => {
    if (!url) {
      return null;
    }
    try {
      return new URL("/favicon.ico", url).href;
    } catch {
      return null;
    }
  }, [url]);

  if (!favicon || failed) {
    return <Globe className="size-3.5 shrink-0 text-slate-400" />;
  }
  return (
    <img
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      src={favicon}
      onError={() => setFailed(true)}
    />
  );
}

export function TerminalTabs() {
  const workspace = useWorkspace();
  const [selectedEditorId, setSelectedEditorId] = useState(readSelectedEditorId);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shortcutModifier = isMacPlatform() ? "⌘" : "Ctrl+";
  const selectedEditor = editorFor(selectedEditorId);

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
    <header className="flex shrink-0 flex-col border-b border-white/10 bg-[#11151b] text-slate-300">
      <div className="flex h-9 items-center justify-end border-b border-white/5 bg-[#151b24] px-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.03)]">
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
      <div className="flex h-11 items-center">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
          {workspace.tabs.map((tab) => {
            const active = tab.id === workspace.activeTabId;
            const isRenaming = tab.id === renamingTabId;
            const isBrowser = tab.kind === "browser";
            const displayTitle = tab.title ?? (isBrowser ? "New tab" : "Shell");
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
                  >
                    {isBrowser ? <BrowserTabIcon url={tab.url} /> : null}
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
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => workspace.setActiveTab(tab.id)}
                        onDoubleClick={() => startRename(tab.id, displayTitle)}
                      >
                        {displayTitle}
                      </button>
                    )}
                    <button
                      aria-label="Close tab"
                      className="rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
                      onClick={() => void workspace.closeTab(tab.id)}
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
                  <ContextMenuItem onSelect={() => void workspace.closeTab(tab.id)}>
                    <X />
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
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
  );
}
