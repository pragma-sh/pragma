import { useEffect } from "react";

import { BrowserView } from "@/components/browser/BrowserView";
import { TerminalView } from "@/components/terminal/TerminalView";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

export function TerminalHost() {
  const workspace = useWorkspace();

  useEffect(() => {
    if (workspace.activeTabId) {
      terminalManager.activate(workspace.activeTabId);
    }
  }, [workspace.activeTabId]);

  return (
    <div className="relative min-h-0 flex-1 bg-[#0b0d10]">
      {workspace.tabs.map((tab) => {
        const worktree = workspace.selectedProjectId
          ? workspace.worktrees[workspace.selectedProjectId]?.find(
              (item) => item.id === tab.worktreeId,
            )
          : undefined;
        const isActive = tab.id === workspace.activeTabId;
        return (
          <div className={cn("absolute inset-0", isActive ? "block" : "hidden")} key={tab.id}>
            {tab.kind === "browser" ? (
              <BrowserView active={isActive} tab={tab} />
            ) : (
              <TerminalView
                cwd={worktree?.path ?? workspace.selectedWorktree?.path ?? "~"}
                tab={tab}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
