import { useMemo, useState } from "react";

import { Globe, Pin, PinOff, TerminalSquare } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { TOUR_ANCHOR } from "@/components/onboarding/WorkspaceTour";
import { IconTooltip } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgentsList } from "@/hooks/use-agents-list";
import { type AgentConfig } from "@/lib/tauri";
import {
  formatWelcomeHeading,
  pickWelcomeHeading,
  welcomeHeadingText,
  welcomeLocation,
} from "@/lib/welcome-headings";
import { isAgentPinned, sortAgentsByPin, toggleAgentPin, useAgentPins } from "@/state/agent-pins";
import { useWorkspace } from "@/state/workspace-context";

/** The "what should we build" heading; one variation, picked once at mount. */
function WelcomeHeading() {
  const workspace = useWorkspace();
  // Lazy initial state so the pick survives re-renders but changes per mount.
  const [heading] = useState(pickWelcomeHeading);

  const worktree = workspace.selectedWorktree;
  const location = welcomeLocation(
    workspace.activeProject?.name,
    worktree ? (worktree.title ?? worktree.branch) : null,
  );
  const parts = formatWelcomeHeading(heading, location);

  if (!parts) {
    return (
      <h1 className="text-foreground text-center text-4xl font-semibold tracking-tight sm:text-5xl">
        What should we build?
      </h1>
    );
  }

  return (
    <h1
      aria-label={welcomeHeadingText(parts)}
      className="text-foreground text-balance text-center text-4xl font-semibold tracking-tight sm:text-5xl"
    >
      {parts.before}
      <span className="welcome-location">{parts.location}</span>
      {parts.after}
    </h1>
  );
}

/** One of the large "open X" action cards. */
function ActionCard({
  description,
  disabled,
  icon,
  label,
  onClick,
}: {
  description: string;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="bg-card hover:border-ring/60 hover:bg-accent/40 flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-border p-5 text-center transition-colors disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="text-muted-foreground flex items-center justify-center">{icon}</span>
      <span className="text-foreground text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-xs">{description}</span>
    </button>
  );
}

/** Left column: open a browser or a terminal tab. */
function OpenCards() {
  const workspace = useWorkspace();
  const disabled = !workspace.selectedWorktree;

  return (
    <div className="flex h-full min-w-0 flex-col gap-3">
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Open</h2>
      <div className="flex flex-1 flex-col gap-3">
        <ActionCard
          description="A native web view inside the workspace."
          disabled={disabled}
          icon={<Globe className="size-8" />}
          label="Open browser"
          onClick={() => void workspace.createBrowserTab()}
        />
        <ActionCard
          description="A shell in the selected worktree."
          disabled={disabled}
          icon={<TerminalSquare className="size-8" />}
          label="Open terminal"
          onClick={() => void workspace.createTerminalTab()}
        />
      </div>
    </div>
  );
}

/** One row in the agent launcher list. */
function AgentRow({ agent, pinned }: { agent: AgentConfig; pinned: boolean }) {
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktree?.id;

  return (
    <div className="group flex items-center gap-1">
      <button
        className="hover:bg-accent/50 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50"
        disabled={!worktreeId}
        onClick={() => {
          if (worktreeId) {
            void workspace.startSession(worktreeId, agent);
          }
        }}
        type="button"
      >
        <AgentIcon agent={agent} />
        <span className="text-foreground min-w-0 flex-1 truncate text-sm">{agent.name}</span>
      </button>
      {/* Hover- (or keyboard-focus-) only: `focus-visible` never sticks after a
        mouse click, so the glyph leaves with the pointer. */}
      <IconTooltip label={pinned ? "Unpin" : "Pin"}>
        <button
          aria-label={pinned ? `Unpin ${agent.name}` : `Pin ${agent.name}`}
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          type="button"
          onClick={() => toggleAgentPin(agent.id)}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      </IconTooltip>
    </div>
  );
}

/** Right column: pinned agents first, then every other installed agent. */
function LaunchAgentPanel() {
  const agents = useAgentsList();
  const pins = useAgentPins();
  const ordered = useMemo(() => sortAgentsByPin(agents, pins), [agents, pins]);

  return (
    <div className="flex h-full min-w-0 flex-col gap-3" data-tour={TOUR_ANCHOR.launchAgent}>
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        Launch agent
      </h2>
      {/* flex-1 + min-h-0: the grid row is sized by the two stacked action
        cards, so this box matches their combined height and the list scrolls
        inside it rather than stretching the row. */}
      <div className="bg-card/40 flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border p-2">
        {ordered.length === 0 ? (
          <p className="text-muted-foreground p-2 text-xs">
            No agents installed. Add one from Settings → Plugins.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 pr-2">
              {ordered.map((agent) => (
                <AgentRow agent={agent} key={agent.id} pinned={isAgentPinned(agent.id)} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

/** Empty state shown when a project is loaded but has no tabs open. */
export function WelcomeScreen() {
  return (
    <div className="bg-canvas flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      {/* Capped and centered. The heading gets the full width so it stays on one
        line; the split grid stays narrower so the cards do not stretch. */}
      <div className="flex w-full max-w-5xl flex-col items-center gap-8">
        <WelcomeHeading />
        <div className="grid w-full max-w-3xl gap-6 sm:grid-cols-2">
          <OpenCards />
          <LaunchAgentPanel />
        </div>
      </div>
    </div>
  );
}
