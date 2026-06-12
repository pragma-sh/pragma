import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useWorkspace } from "@/state/workspace-context";
import type { WorktreeNode } from "@/lib/worktree-tree";

interface Props {
  nodes: WorktreeNode[];
  onCreateWorktree: (parentId: string) => void;
}

function WorktreeRow({
  node,
  depth,
  onCreateWorktree,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateWorktree: (parentId: string) => void;
}) {
  const { state, dispatch } = useWorkspace();
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = state.selectedWorktreeId === node.worktree.id;

  const label = node.worktree.title ?? node.worktree.branch ?? "main";

  return (
    <div>
      <div className="group flex items-center">
        <button
          onClick={() => dispatch({ type: "SELECT_WORKTREE", worktreeId: node.worktree.id })}
          className={`flex flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm ${
            isSelected ? "bg-accent" : "hover:bg-accent/50"
          }`}
          style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(!open);
              }}
              className="w-4 shrink-0 text-muted-foreground cursor-pointer"
            >
              {open ? (
                <ChevronRight className="size-3 rotate-90" />
              ) : (
                <ChevronRight className="size-3" />
              )}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="truncate">{label}</span>
        </button>
        <button
          title="New nested worktree"
          onClick={() => onCreateWorktree(node.worktree.id)}
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        >
          <Plus className="size-3" />
        </button>
      </div>
      {open && hasChildren && (
        <div className="border-l ml-[1.125rem]">
          {node.children.map((child) => (
            <WorktreeRow
              key={child.worktree.id}
              node={child}
              depth={depth + 1}
              onCreateWorktree={onCreateWorktree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorktreeTree({ nodes, onCreateWorktree }: Props) {
  return (
    <div className="mt-1 flex-1 space-y-0.5 px-2 overflow-auto">
      {nodes.map((node) => (
        <WorktreeRow
          key={node.worktree.id}
          node={node}
          depth={0}
          onCreateWorktree={onCreateWorktree}
        />
      ))}
    </div>
  );
}
