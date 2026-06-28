import { type KeyboardEvent, type MouseEvent, useCallback } from "react";

import { GitBranch, Loader2, Trash2 } from "lucide-react";

import type { KanbanCompletedAction, KanbanPromptCard } from "@pragma/constants";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentIcon } from "@/components/agents/AgentIcon";
import { Button } from "@/components/ui/button";
import type { AgentConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";

const COMPLETING_BADGE_CLASS = "bg-warning/15 text-warning";
const PR_BADGE_CLASS = "bg-skill/15 text-skill";
const MERGED_BADGE_CLASS = "bg-success/15 text-success";

interface KanbanCardProps {
  card: KanbanPromptCard;
  /** Agent launcher config resolved from the card's agentId. */
  agent: AgentConfig | null;
  /** The background completion action running on this card, if any. */
  completingAction?: KanbanCompletedAction | null;
  onOpen: (card: KanbanPromptCard) => void;
  onDelete: (card: KanbanPromptCard) => void;
}

/** Label shown while a background completion action is running. */
function completingBadgeLabel(action: KanbanCompletedAction): string {
  return action === "commitMerge" ? "Merging…" : "Opening PR…";
}

type CompletedBadge = { label: string; className: string; spinning: boolean };

/** The status badge for a completed card (merging/PR/merged), or null. */
function completedBadge(
  card: KanbanPromptCard,
  completingAction: KanbanCompletedAction | null,
): CompletedBadge | null {
  if (completingAction) {
    return {
      label: completingBadgeLabel(completingAction),
      className: COMPLETING_BADGE_CLASS,
      spinning: true,
    };
  }
  if (card.pullRequestUrl) {
    return {
      label: card.pullRequestNumber ? `PR #${card.pullRequestNumber}` : "PR",
      className: PR_BADGE_CLASS,
      spinning: false,
    };
  }
  if (card.completedAction === "commitMerge") {
    return { label: "Merged", className: MERGED_BADGE_CLASS, spinning: false };
  }
  return null;
}

/** A small colored status badge in the card header. */
function KanbanCardBadge({ badge }: { badge: CompletedBadge }) {
  return (
    <span
      className={cn(
        "ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium",
        badge.className,
        badge.spinning && "flex items-center gap-1",
      )}
    >
      {badge.spinning ? <Loader2 className="size-3 animate-spin" /> : null}
      {badge.label}
    </span>
  );
}

/** The card footer: agent icon + model, and the hover-revealed delete button. */
function KanbanCardFooter({
  card,
  displayAgent,
  onDelete,
}: {
  card: KanbanPromptCard;
  displayAgent: AgentConfig;
  onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-flex shrink-0"
          title={displayAgent.name}
          aria-label={`Agent: ${displayAgent.name}`}
        >
          <AgentIcon agent={displayAgent} />
        </span>
        {card.modelId ? (
          <span className="truncate" title={card.modelId}>
            {card.modelId}
          </span>
        ) : null}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Delete card"
        className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/**
 * One prompt card. Its affordances are status-driven and enforce the allowed
 * transitions: drafts edit/start, in-progress cards open their session (and show
 * live agent status), review cards expose Merge/PR completion buttons, completed
 * cards show their merge/PR outcome (or a live "Merging…"/"Opening PR…" badge
 * while the background job runs).
 */
export function KanbanCard({ card, agent, completingAction, onOpen, onDelete }: KanbanCardProps) {
  // Only in-progress cards have a live agent session to reflect.
  const agentStatus = useTabAgentStatus(
    card.status === "inProgress" ? (card.agentTabId ?? null) : null,
  );

  const clickable = card.status === "inProgress" || card.status === "reviewNeeded";
  const displayAgent: AgentConfig = agent ?? {
    id: card.agentId,
    name: card.agentId,
    iconDataUrl: null,
    start: [],
  };

  const handleOpen = useCallback(() => onOpen(card), [onOpen, card]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter") onOpen(card);
    },
    [onOpen, card],
  );
  const handleDelete = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onDelete(card);
    },
    [onDelete, card],
  );

  const badge: CompletedBadge | null =
    card.status === "completed" ? completedBadge(card, completingAction ?? null) : null;
  // In-progress / review cards navigate to their worktree session on click.
  const cardProps = clickable
    ? {
        onClick: handleOpen,
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: handleKeyDown,
        style: { cursor: "pointer" as const },
      }
    : {};

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- clickable cards add role/tabIndex/keydown below; non-clickable cards attach no handlers.
    <div className="space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm" {...cardProps}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">{card.branchName}</span>
        {card.status === "inProgress" ? (
          <AgentStatusDot status={agentStatus} className="ml-auto" />
        ) : null}
        {badge ? <KanbanCardBadge badge={badge} /> : null}
      </div>

      <p className="line-clamp-3 whitespace-pre-wrap text-sm">{card.prompt || "No prompt"}</p>

      <KanbanCardFooter card={card} displayAgent={displayAgent} onDelete={handleDelete} />
    </div>
  );
}
