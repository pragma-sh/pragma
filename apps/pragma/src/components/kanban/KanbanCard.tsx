import { GitBranch, Loader2, Trash2 } from "lucide-react";

import type { KanbanCompletedAction, KanbanPromptCard } from "@pragma/constants";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentIcon } from "@/components/agents/AgentIcon";
import { Button } from "@/components/ui/button";
import type { AgentConfig } from "@/lib/tauri";
import { useTabAgentStatus } from "@/state/agent-status-store";

interface KanbanCardProps {
  card: KanbanPromptCard;
  /** Agent launcher config resolved from the card's agentId. */
  agent: AgentConfig | null;
  /** The background completion action running on this card, if any. */
  completingAction?: KanbanCompletedAction | null;
  onOpen: (card: KanbanPromptCard) => void;
  onDelete: (card: KanbanPromptCard) => void;
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

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- clickable cards add role/tabIndex/keydown below; non-clickable cards attach no handlers.
    <div
      className="space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm"
      // In-progress / review cards navigate to their worktree session on click.
      onClick={clickable ? () => onOpen(card) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === "Enter") {
                onOpen(card);
              }
            }
          : undefined
      }
      style={clickable ? { cursor: "pointer" } : undefined}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">{card.branchName}</span>
        {card.status === "inProgress" ? (
          <AgentStatusDot status={agentStatus} className="ml-auto" />
        ) : null}
        {card.status === "completed" && completingAction ? (
          <span className="ml-auto flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
            <Loader2 className="size-3 animate-spin" />
            {completingAction === "commitMerge" ? "Merging…" : "Opening PR…"}
          </span>
        ) : card.status === "completed" && card.pullRequestUrl ? (
          <span className="ml-auto rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-400">
            {card.pullRequestNumber ? `PR #${card.pullRequestNumber}` : "PR"}
          </span>
        ) : card.status === "completed" && card.completedAction === "commitMerge" ? (
          <span className="ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
            Merged
          </span>
        ) : null}
      </div>

      <p className="line-clamp-3 whitespace-pre-wrap text-sm">{card.prompt || "No prompt"}</p>

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
          onClick={(event) => {
            event.stopPropagation();
            onDelete(card);
          }}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
