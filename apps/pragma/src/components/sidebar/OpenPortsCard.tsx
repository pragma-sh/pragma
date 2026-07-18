import { useMemo, useState } from "react";
import { ChevronDown, Network } from "lucide-react";

import type { Tab, Worktree } from "@pragma/constants";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { OpenPort } from "@/lib/tauri";
import { useOpenPorts } from "@/state/open-ports-context";
import { useWorkspace } from "@/state/workspace-context";

interface WorktreePortGroup {
  worktree: Worktree;
  rows: Array<{ port: OpenPort; tab: Tab }>;
}

function labelWorktree(worktree: Worktree): string {
  return worktree.title || worktree.branch;
}

function labelTab(tab: Tab): string {
  return tab.title || "Terminal";
}

/** Sidebar inventory of listeners owned by visible terminal tabs. */
export function OpenPortsCard() {
  const [open, setOpen] = useState(true);
  const ports = useOpenPorts();
  const workspace = useWorkspace();
  const groups = useMemo(() => groupPorts(ports, workspace), [ports, workspace]);
  const count = groups.reduce((total, group) => total + group.rows.length, 0);
  if (count === 0) return null;

  return (
    <Collapsible
      className="mb-2 rounded-lg border border-sidebar-border bg-card shadow-sm"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-label="Toggle open ports panel"
        className="group flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Network className="size-3.5 text-muted-foreground" />
          <span className="truncate text-xs font-semibold text-muted-foreground">Ports</span>
          {count > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-0" : "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-2">
        <TooltipProvider delayDuration={300}>
          <div className="space-y-1">
            {groups.map((group) => (
              <WorktreePorts group={group} key={group.worktree.id} />
            ))}
          </div>
        </TooltipProvider>
      </CollapsibleContent>
    </Collapsible>
  );
}

function WorktreePorts({ group }: { group: WorktreePortGroup }) {
  const [open, setOpen] = useState(true);
  const workspace = useWorkspace();
  const projectId = workspace.selectedProjectId;
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-muted/60">
        <ChevronDown
          className={cn("size-3 text-muted-foreground transition-transform", !open && "-rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{labelWorktree(group.worktree)}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{group.rows.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-4 border-l border-sidebar-border pl-2">
        {group.rows.map(({ port, tab }) => (
          <Tooltip key={`${port.tabId}:${port.port}`}>
            <TooltipTrigger asChild>
              <button
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  if (projectId) {
                    void workspace.activateTabLocation(projectId, port.worktreeId, port.tabId);
                  }
                }}
                type="button"
              >
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {port.port}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {port.process}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Terminal: {labelTab(tab)}</TooltipContent>
          </Tooltip>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function groupPorts(
  ports: OpenPort[],
  workspace: ReturnType<typeof useWorkspace>,
): WorktreePortGroup[] {
  const projectId = workspace.selectedProjectId;
  const worktrees = projectId
    ? (workspace.worktrees[projectId] ?? []).filter((worktree) => !worktree.hidden)
    : [];
  const tabById = new Map(
    workspace.projectTabs.filter((tab) => tab.kind === "terminal").map((tab) => [tab.id, tab]),
  );
  return worktrees.flatMap((worktree) => {
    const rows = ports.flatMap((port) => {
      if (port.worktreeId !== worktree.id) return [];
      const tab = tabById.get(port.tabId);
      return tab?.worktreeId === worktree.id ? [{ port, tab }] : [];
    });
    return rows.length > 0 ? [{ worktree, rows }] : [];
  });
}
