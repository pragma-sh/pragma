import { useEffect, useState } from "react";
import { ChevronDown, StickyNote } from "lucide-react";

import { constants, type ScratchpadSummary } from "@pragma/constants";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { cn } from "@/lib/utils";
import { listScratchpads } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

/** Prefix every managed scratchpad file shares, used to filter watch events. */
const SCRATCHPAD_PREFIX = `${constants.scratchpads.directory}/`;

/** Sidebar inventory of managed scratchpad files in the currently selected worktree. */
export function ScratchpadsCard() {
  const [open, setOpen] = useState(true);
  const kanban = useKanban();
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktreeId;
  const [scratchpads, setScratchpads] = useState<ScratchpadSummary[]>([]);
  const [revision, setRevision] = useState(0);

  // An agent creating, renaming, or deleting a scratchpad file touches no tab,
  // so without the watcher this list stayed stale until tabs happened to churn.
  useWorktreeFileChange(worktreeId ?? "", (change) => {
    if (change.path.startsWith(SCRATCHPAD_PREFIX)) setRevision((value) => value + 1);
  });

  useEffect(() => {
    if (!worktreeId) {
      setScratchpads([]);
      return;
    }
    let cancelled = false;
    async function load(id: string) {
      try {
        const result = await listScratchpads(id);
        if (!cancelled) setScratchpads(result);
      } catch {
        if (!cancelled) setScratchpads([]);
      }
    }
    void load(worktreeId);
    return () => {
      cancelled = true;
    };
    // Re-list whenever tabs change too, so creating/closing a scratchpad tab
    // (which writes/removes its file) refreshes this worktree-scoped list, and
    // whenever the worktree watcher reports a change under the scratchpad dir.
  }, [worktreeId, workspace.projectTabs, revision]);

  if (scratchpads.length === 0) return null;

  return (
    <Collapsible
      className="mb-2 rounded-lg border border-sidebar-border bg-card shadow-sm"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-label="Toggle scratchpads panel"
        className="group flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StickyNote className="size-3.5 text-muted-foreground" />
          <span className="truncate text-xs font-semibold text-muted-foreground">Scratchpads</span>
          <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {scratchpads.length}
          </span>
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
        <div className="space-y-0.5">
          {scratchpads.map((scratchpad) => (
            <button
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              key={scratchpad.id}
              onClick={() => {
                // The board replaces the normal shell, where scratchpad tabs render.
                kanban.exitBoard();
                void workspace.openScratchpadFile(scratchpad.filePath, scratchpad.title);
              }}
              type="button"
            >
              <StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{scratchpad.title}</span>
            </button>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
