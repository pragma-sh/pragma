import type { Tab, Worktree } from "@pragma/constants";
import { TerminalView } from "./TerminalView";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  worktrees: Worktree[];
  attachableTabIds: Set<string>;
}

export function TerminalHost({ tabs, activeTabId, worktrees, attachableTabIds }: Props) {
  const worktreeMap = new Map(worktrees.map((w) => [w.id, w]));

  return (
    <div className="flex-1 relative overflow-hidden bg-zinc-950">
      {tabs.map((tab) => {
        const wt = worktreeMap.get(tab.worktreeId);
        return (
          <TerminalView
            key={tab.id}
            sessionId={tab.id}
            cwd={wt?.path ?? "/"}
            useAttach={attachableTabIds.has(tab.id)}
            visible={tab.id === activeTabId}
          />
        );
      })}
    </div>
  );
}
