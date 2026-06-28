import { useEffect, useMemo, useState } from "react";

import { GripVertical, Plus } from "lucide-react";
import { toast } from "sonner";

import type { KanbanPromptCard, KanbanPromptStatus } from "@pragma/constants";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import { KanbanCompletionDialog } from "@/components/kanban/KanbanCompletionDialog";
import { KanbanDeleteDialog } from "@/components/kanban/KanbanDeleteDialog";
import { KanbanDraftDialog } from "@/components/kanban/KanbanDraftDialog";
import { Button } from "@/components/ui/button";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  type KanbanMoveEvent,
  KanbanOverlay,
} from "@/components/ui/kanban";
import { routeKanbanMove } from "@/lib/kanban-move";
import { type AgentConfig, moveKanbanCard } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

interface ColumnSpec {
  status: KanbanPromptStatus;
  title: string;
}

const COLUMNS: ColumnSpec[] = [
  { status: "draft", title: "Drafts" },
  { status: "inProgress", title: "In progress" },
  { status: "reviewNeeded", title: "Review needed" },
  { status: "completed", title: "Completed" },
];

// dnd-kit reads a value/onValueChange pair; with `onMove` set the board never
// mutates the map itself, so a no-op setter keeps it fully controlled by cards.
function noop() {}

/**
 * Full-shell prompt board for the selected project. Renders four status columns
 * of persisted cards with drag-and-drop between columns and hosts the draft and
 * completion modals. A card dropped into a new column is routed through the same
 * transition the per-card buttons use (start, mark review, complete); reorders
 * within a column and unsupported drops are ignored. The board is left by
 * selecting a worktree in the sidebar (or Escape); card-driven navigation is what
 * leaves a "Back to Kanban" control in the normal shell.
 */
export function ProjectKanbanWorkspace() {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const [draftDialog, setDraftDialog] = useState<{ open: boolean; card: KanbanPromptCard | null }>({
    open: false,
    card: null,
  });
  const [completionCard, setCompletionCard] = useState<KanbanPromptCard | null>(null);
  const [deletionCard, setDeletionCard] = useState<KanbanPromptCard | null>(null);

  const cardsByStatus = useMemo(() => {
    const groups: Record<KanbanPromptStatus, KanbanPromptCard[]> = {
      draft: [],
      inProgress: [],
      reviewNeeded: [],
      completed: [],
    };
    for (const card of kanban.cards) {
      // While the completion modal is open for a dragged card, show it parked in
      // Completed (it's not persisted there until a completion path runs, so a
      // cancel just drops this override and the card snaps back).
      const status = card.id === completionCard?.id ? "completed" : card.status;
      groups[status].push(card);
    }
    return groups;
  }, [kanban.cards, completionCard]);

  const anyDialogOpen = draftDialog.open || completionCard !== null || deletionCard !== null;

  // Escape exits the board when no modal is open (modals own their own Escape).
  const { exitBoard } = kanban;
  useEffect(() => {
    if (anyDialogOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        exitBoard();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyDialogOpen, exitBoard]);

  function agentConfig(card: KanbanPromptCard): AgentConfig | null {
    return kanban.agents.find((agent) => agent.id === card.agentId) ?? null;
  }

  async function start(card: KanbanPromptCard) {
    try {
      await kanban.startCard(card);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // Route a card dropped into a different column to the matching transition. We
  // only honor the forward steps that have defined behavior; everything else
  // snaps back (the board is controlled by `kanban.cards`, untouched until a
  // transition persists and reloads).
  async function handleMove({ activeContainer, overContainer, event }: KanbanMoveEvent) {
    const from = activeContainer as KanbanPromptStatus;
    const to = overContainer as KanbanPromptStatus;
    const card = kanban.cards.find((item) => item.id === String(event.active.id));
    if (!card) {
      return;
    }

    switch (routeKanbanMove(from, to)) {
      case "start":
        await start(card);
        break;
      case "review":
        try {
          await moveKanbanCard(card.id, "reviewNeeded");
          await kanban.reload();
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : String(cause));
        }
        break;
      case "complete":
        setCompletionCard(card);
        break;
      case "blocked":
        toast.info("That move isn't available — use the card's actions to advance it.");
        break;
      case "noop":
        break;
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      <header className="flex items-center justify-between gap-3 border-b border-sidebar-border px-4 py-3">
        <h1 className="truncate text-base font-semibold">Prompt board</h1>
      </header>

      <div className="flex min-h-0 flex-1 overflow-x-auto p-4">
        <Kanban
          value={cardsByStatus as Record<string, KanbanPromptCard[]>}
          onValueChange={noop}
          getItemValue={(card) => card.id}
          onMove={(move) => void handleMove(move)}
          className="mx-auto min-h-0"
        >
          <KanbanBoard className="flex w-fit gap-4">
            {COLUMNS.map((column) => {
              const cards = cardsByStatus[column.status];
              return (
                // Columns stay put (we render no column drag handle, so they can't
                // be dragged) but remain drop targets so cards land in empty columns.
                <KanbanColumn key={column.status} value={column.status} className="w-72">
                  {/* Fixed-height action row keeps every column header aligned while
                      the New draft button sits directly above the Drafts column. */}
                  <div className="mb-2 flex h-8 items-center">
                    {column.status === "draft" ? (
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!workspace.selectedProjectId}
                        onClick={() => setDraftDialog({ open: true, card: null })}
                      >
                        <Plus className="size-4" />
                        New draft
                      </Button>
                    ) : null}
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-background/40">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <h2 className="text-sm font-semibold">{column.title}</h2>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {cards.length}
                      </span>
                    </div>
                    <KanbanColumnContent
                      value={column.status}
                      className="min-h-0 flex-1 gap-2 overflow-y-auto p-2"
                    >
                      {cards.length === 0 ? (
                        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                          {column.status === "draft" && !kanban.loading
                            ? "Add a draft to get started."
                            : "Nothing here yet."}
                        </p>
                      ) : (
                        cards.map((card) => (
                          <KanbanItem
                            key={card.id}
                            value={card.id}
                            className="group/item flex items-stretch gap-1"
                          >
                            <KanbanItemHandle
                              aria-label="Drag card"
                              className="flex w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100"
                            >
                              <GripVertical className="size-4" />
                            </KanbanItemHandle>
                            <div className="min-w-0 flex-1">
                              <KanbanCard
                                card={card}
                                agent={agentConfig(card)}
                                completingAction={kanban.completing[card.id] ?? null}
                                onOpen={(item) => kanban.openCardWorktree(item)}
                                onDelete={(item) => setDeletionCard(item)}
                              />
                            </div>
                          </KanbanItem>
                        ))
                      )}
                    </KanbanColumnContent>
                  </div>
                </KanbanColumn>
              );
            })}
          </KanbanBoard>

          <KanbanOverlay>
            {({ value }) => {
              const card = kanban.cards.find((item) => item.id === String(value));
              if (!card) {
                return null;
              }
              return (
                <div className="w-72 pl-6">
                  <KanbanCard
                    card={card}
                    agent={agentConfig(card)}
                    completingAction={kanban.completing[card.id] ?? null}
                    onOpen={() => {}}
                    onDelete={() => {}}
                  />
                </div>
              );
            }}
          </KanbanOverlay>
        </Kanban>
      </div>

      <KanbanDraftDialog
        open={draftDialog.open}
        card={draftDialog.card}
        onOpenChange={(open) => setDraftDialog((current) => ({ ...current, open }))}
      />
      <KanbanCompletionDialog
        open={completionCard !== null}
        card={completionCard}
        onOpenChange={(open) => {
          if (!open) {
            setCompletionCard(null);
          }
        }}
      />
      <KanbanDeleteDialog
        open={deletionCard !== null}
        card={deletionCard}
        onOpenChange={(open) => {
          if (!open) {
            setDeletionCard(null);
          }
        }}
      />
    </section>
  );
}
