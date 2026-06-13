import { useState } from "react";

import { ChevronRight, GitBranch, GitBranchPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buildWorktreeTree, type WorktreeNode } from "@/lib/worktree-tree";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

interface WorktreeTreeProps {
  onCreateChild: () => void;
}

export function WorktreeTree({ onCreateChild }: WorktreeTreeProps) {
  const workspace = useWorkspace();
  const worktrees = workspace.selectedProjectId
    ? (workspace.worktrees[workspace.selectedProjectId] ?? [])
    : [];
  const tree = buildWorktreeTree(worktrees);

  if (tree.length === 0) {
    return <p className="px-2 py-6 text-sm text-muted-foreground">No worktrees loaded.</p>;
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <WorktreeRow key={node.worktree.id} node={node} depth={0} onCreateChild={onCreateChild} />
      ))}
    </div>
  );
}

function WorktreeRow({
  node,
  depth,
  onCreateChild,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateChild: () => void;
}) {
  const workspace = useWorkspace();
  const selected = workspace.selectedWorktreeId === node.worktree.id;
  const label = node.worktree.isMain ? "main" : (node.worktree.title ?? node.worktree.branch);
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm",
          selected
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/70",
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            className="flex w-3 items-center justify-center"
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight className={cn("size-3 opacity-60", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="w-3" />
        )}
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => workspace.selectWorktree(node.worktree.id)}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        {node.worktree.isMain ? null : (
          <Button
            aria-label={`Create child worktree from ${label}`}
            className="opacity-0 group-hover:opacity-100"
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              workspace.selectWorktree(node.worktree.id);
              onCreateChild();
            }}
          >
            <GitBranchPlus />
          </Button>
        )}
      </div>
      {expanded &&
        node.children.map((child) => (
          <WorktreeRow
            key={child.worktree.id}
            node={child}
            depth={depth + 1}
            onCreateChild={onCreateChild}
          />
        ))}
    </div>
  );
}
