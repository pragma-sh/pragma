import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

export function TerminalTabs() {
  const workspace = useWorkspace();

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-white/10 bg-[#11151b] text-slate-300">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto px-2">
        {workspace.tabs.map((tab) => {
          const active = tab.id === workspace.activeTabId;
          return (
            <div
              className={cn(
                "group mr-1 flex h-8 min-w-32 max-w-52 items-center rounded-lg border px-2 text-sm",
                active
                  ? "border-slate-600 bg-slate-800 text-white"
                  : "border-transparent bg-transparent hover:bg-slate-900",
              )}
              key={tab.id}
            >
              <button
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => workspace.setActiveTab(tab.id)}
              >
                {tab.title ?? "Shell"}
              </button>
              <button
                aria-label="Close tab"
                className="rounded p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100"
                onClick={() => {
                  terminalManager.dispose(tab.id);
                  void workspace.closeTerminalTab(tab.id);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <Button
        className="mr-2 text-slate-200 hover:bg-white/10 hover:text-white"
        disabled={!workspace.selectedWorktree}
        size="icon-sm"
        variant="ghost"
        onClick={() => void workspace.createTerminalTab()}
        aria-label="New terminal tab"
      >
        <Plus />
      </Button>
    </header>
  );
}
