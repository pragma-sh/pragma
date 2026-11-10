import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  RenderPluginContribution,
  RenderPluginCount,
  usePluginSidebarCards,
} from "@/plugins/rendering";
import { useWorkspace } from "@/state/workspace-context";

/** Plugin `sidebarCards`, stacked below the worktree tree. */
export function PluginSidebarCards() {
  const workspace = useWorkspace();
  const cards = usePluginSidebarCards(workspace.selectedProjectId);
  if (cards.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 space-y-2">
      {cards.map((card) => (
        <PluginSidebarCardItem card={card} key={card.key} />
      ))}
    </div>
  );
}

/** No arguments: a sidebar card's count hook is not scoped to a worktree. */
const NO_ARGS: [] = [];

function PluginSidebarCardItem({
  card,
}: {
  card: ReturnType<typeof usePluginSidebarCards>[number];
}) {
  const [open, setOpen] = useState(true);
  const [count, setCount] = useState<number | null>(null);
  const { useCount } = card.contribution;
  // A counted card hides at 0 (or before its count is known); the probe keeps
  // running while it is hidden so the card reappears when the count rises.
  const probe = useCount ? (
    <RenderPluginCount
      args={NO_ARGS}
      config={card.record.config}
      onCount={setCount}
      pluginId={card.pluginId}
      resetKey={card.key}
      useCount={useCount}
    />
  ) : null;
  // The probe keeps one position whether or not the card shows: moving it would
  // remount it, reset the count to null, hide the card, and loop.
  return (
    <>
      {probe}
      {useCount && !count ? null : (
        <PluginSidebarCardBody
          card={card}
          count={useCount ? count : undefined}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function PluginSidebarCardBody({
  card,
  count,
  open,
  onOpenChange,
}: {
  card: ReturnType<typeof usePluginSidebarCards>[number];
  count: number | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { icon: Icon, title } = card.contribution;
  return (
    <Collapsible
      className="rounded-lg border border-sidebar-border bg-card shadow-sm"
      data-slot="plugin-sidebar-card"
      onOpenChange={onOpenChange}
      open={open}
    >
      <CollapsibleTrigger
        aria-label={`Toggle ${title} panel`}
        className="group flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          <h3 className="truncate text-xs font-semibold text-muted-foreground">{title}</h3>
          {count !== undefined ? (
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
      <CollapsibleContent className="px-3 pb-3">
        <RenderPluginContribution
          component={card.contribution.component}
          config={card.record.config}
          pluginId={card.pluginId}
          resetKey={card.key}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
