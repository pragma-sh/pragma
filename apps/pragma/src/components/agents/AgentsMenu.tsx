import { useEffect, useMemo, useState } from "react";

import { Bot, ChevronDown, Pin, PinOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIconNeedsInvert } from "@/lib/icon-contrast";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { type AgentConfig, listAgents, ptyWrite } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { isAgentPinned, toggleAgentPin, useAgentPins } from "@/state/agent-pins";
import { useWorkspace } from "@/state/workspace-context";

const AGENT_START_DELAY_MS = 500;

/** Dropdown and pinned chips for launching configured external agents. */
export function AgentsMenu() {
  const workspace = useWorkspace();
  const pins = useAgentPins();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [open, setOpen] = useState(false);
  useSuppressNativeOverlayWhile(open);

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) {
          setAgents(Array.isArray(items) ? items : []);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pinnedAgents = useMemo(() => agents.filter((agent) => pins.has(agent.id)), [agents, pins]);

  async function launch(agent: AgentConfig) {
    const tab = await workspace.createTerminalTab();
    if (!tab) {
      return;
    }
    const command = commandFor(agent.start);
    window.setTimeout(() => void ptyWrite(tab.id, `${command}\r`), AGENT_START_DELAY_MS);
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      {pinnedAgents.length > 0 ? (
        <div className="flex max-w-64 items-center gap-1 overflow-x-auto pr-1">
          {pinnedAgents.map((agent) => (
            <Tooltip key={agent.id}>
              <TooltipTrigger asChild>
                <Button
                  className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                  size="icon"
                  variant="ghost"
                  disabled={!workspace.selectedWorktree}
                  onClick={() => void launch(agent)}
                  aria-label={`Launch ${agent.name}`}
                >
                  <AgentIcon agent={agent} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{agent.name}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button disabled={!workspace.selectedWorktree} size="sm" variant="outline">
            <Bot className="size-3.5" />
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
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-white/10 hover:text-white"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleAgentPin(agent.id);
                  }}
                  aria-label={isAgentPinned(agent.id) ? `Unpin ${agent.name}` : `Pin ${agent.name}`}
                >
                  {isAgentPinned(agent.id) ? (
                    <PinOff className="size-3" />
                  ) : (
                    <Pin className="size-3" />
                  )}
                </button>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AgentIcon({ agent }: { agent: AgentConfig }) {
  const needsInvert = useIconNeedsInvert(agent.iconDataUrl);
  return agent.iconDataUrl ? (
    <img
      alt=""
      className={cn("size-4 rounded-sm", needsInvert && "invert")}
      src={agent.iconDataUrl}
    />
  ) : (
    <Bot className={cn("size-4 text-amber-200")} />
  );
}

function commandFor(start: string[]): string {
  if (start.length === 1) {
    return start[0]!;
  }
  return start.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[\w./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
