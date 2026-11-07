import { useMemo } from "react";
import { Network } from "lucide-react";

import type { Tab } from "@pragma-sh/constants";
import type { PluginWorktree } from "@pragma-sh/plugin";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { OpenPort } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useOpenPorts } from "@/state/open-ports-context";
import { useWorkspace } from "@/state/workspace-context";
import { SectionItem } from "./SectionItem";
import type { BuiltInWorktreeSection } from "./types";

/** A listener and the terminal tab that owns it. */
interface PortRow {
  port: OpenPort;
  tab: Tab;
}

/** Listeners owned by this worktree's open terminal tabs. */
function useWorktreePorts(worktreeId: string): PortRow[] {
  const ports = useOpenPorts();
  const { projectTabs } = useWorkspace();
  return useMemo(() => {
    const tabById = new Map(
      projectTabs
        .filter((tab) => tab.kind === "terminal" && tab.worktreeId === worktreeId)
        .map((tab) => [tab.id, tab]),
    );
    return ports.flatMap((port) => {
      const tab = port.worktreeId === worktreeId ? tabById.get(port.tabId) : undefined;
      return tab ? [{ port, tab }] : [];
    });
  }, [ports, projectTabs, worktreeId]);
}

function PortsBody({ worktree }: { worktree: PluginWorktree }) {
  const rows = useWorktreePorts(worktree.id);
  const kanban = useKanban();
  const workspace = useWorkspace();
  return (
    <TooltipProvider delayDuration={300}>
      {rows.map(({ port, tab }) => (
        <Tooltip key={`${port.tabId}:${port.port}`}>
          <TooltipTrigger asChild>
            <SectionItem
              onClick={() => {
                kanban.exitBoard();
                void workspace.activateTabLocation(worktree.projectId, worktree.id, port.tabId);
              }}
            >
              <span className="font-mono font-medium tabular-nums text-foreground">
                {port.port}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{port.process}</span>
            </SectionItem>
          </TooltipTrigger>
          <TooltipContent side="right">Terminal: {tab.title || "Terminal"}</TooltipContent>
        </Tooltip>
      ))}
    </TooltipProvider>
  );
}

/** Listeners owned by the worktree's terminal tabs; a click opens the owning tab. */
export const portsSection: BuiltInWorktreeSection = {
  id: "ports",
  title: "Ports",
  icon: Network,
  useCount: (worktree) => useWorktreePorts(worktree.id).length,
  Body: PortsBody,
};
