import { useMemo, useState } from "react";

import { ChevronDown, Pin, PinOff } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { Button } from "@/components/ui/button";
import { IconButton, IconTooltip } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentsList } from "@/hooks/use-agents-list";
import { startAgentInTab } from "@/lib/agent-launch";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { type AgentConfig } from "@/lib/tauri";
import { isAgentPinned, toggleAgentPin, useAgentPins } from "@/state/agent-pins";
import { useWorkspace } from "@/state/workspace-context";

/** Dropdown and pinned chips for launching configured external agents. */
export function AgentsMenu() {
  const workspace = useWorkspace();
  const pins = useAgentPins();
  const agents = useAgentsList();
  const [open, setOpen] = useState(false);
  useSuppressNativeOverlayWhile(open);

  const pinnedAgents = useMemo(() => agents.filter((agent) => pins.has(agent.id)), [agents, pins]);

  async function launch(agent: AgentConfig) {
    const tab = await workspace.createTerminalTab();
    if (!tab) {
      return;
    }
    void workspace.markTabAgent(tab.id, agent);
    startAgentInTab(tab.id, agent);
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      {pinnedAgents.length > 0 ? (
        <div className="flex max-w-64 items-center gap-1 overflow-x-auto pr-1">
          {pinnedAgents.map((agent) => (
            <IconButton
              aria-label={`Launch ${agent.name}`}
              className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              disabled={!workspace.selectedWorktree}
              key={agent.id}
              label={agent.name}
              size="icon"
              variant="ghost"
              onClick={() => void launch(agent)}
            >
              <AgentIcon agent={agent} />
            </IconButton>
          ))}
        </div>
      ) : null}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            className="text-foreground"
            disabled={!workspace.selectedWorktree}
            size="sm"
            variant="outline"
          >
            <span>Open agent</span>
            <ChevronDown className="size-3 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuLabel>Launch agent</DropdownMenuLabel>
          {agents.length === 0 ? (
            <DropdownMenuItem disabled>No agents configured</DropdownMenuItem>
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem
                className="gap-2"
                key={agent.id}
                onSelect={() => void launch(agent)}
              >
                <AgentIcon agent={agent} />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <IconTooltip label={isAgentPinned(agent.id) ? "Unpin" : "Pin"}>
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleAgentPin(agent.id);
                    }}
                    aria-label={
                      isAgentPinned(agent.id) ? `Unpin ${agent.name}` : `Pin ${agent.name}`
                    }
                  >
                    {isAgentPinned(agent.id) ? (
                      <PinOff className="size-3" />
                    ) : (
                      <Pin className="size-3" />
                    )}
                  </button>
                </IconTooltip>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
