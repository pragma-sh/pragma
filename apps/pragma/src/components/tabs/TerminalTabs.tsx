import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Globe, Pencil, Plus, SquareTerminal, X } from "lucide-react";

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
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shortcutModifier = isMacPlatform() ? "⌘" : "Ctrl+";

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

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-white/10 bg-[#11151b] text-slate-300">
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
    </header>
  );
}
