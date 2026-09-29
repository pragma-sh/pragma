import { useEffect, useRef } from "react";

import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { AgentLaunchOptionsState } from "@/hooks/use-agent-launch-options";
import { cn } from "@/lib/utils";

/**
 * The prompt footer: the current mode (Shift+Tab cycles it) and the permission
 * mode dropdown. Renders nothing for an agent that declares neither.
 */
export function AgentLaunchOptionsBar({ launch }: { launch: AgentLaunchOptionsState }) {
  // A control with a single choice has nothing to choose, so it is not shown.
  const { modes, permissionModes } = launch.options;
  if (modes.length < 2 && permissionModes.length < 2) {
    return null;
  }
  const mode =
    modes.length < 2 ? undefined : (modes.find((item) => item.id === launch.modeId) ?? modes[0]);
  const permission =
    permissionModes.length < 2
      ? undefined
      : (permissionModes.find((item) => item.id === launch.permissionModeId) ?? permissionModes[0]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {mode ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Agent mode"
          title={mode.description ?? "Cycle the agent mode"}
          className="h-7 gap-1.5 px-2 font-normal"
          onClick={launch.cycleMode}
        >
          <span className="text-muted-foreground">Agent</span>
          <span>{mode.name}</span>
          <Kbd>⇧⇥</Kbd>
        </Button>
      ) : null}
      {permission ? (
        <Select value={permission.id} onValueChange={launch.setPermissionModeId}>
          <SelectTrigger aria-label="Permission mode" size="sm" className="font-normal">
            <span data-slot="select-value">
              <ShieldCheck className="size-3.5" />
              <span className="truncate">{permission.name}</span>
            </span>
          </SelectTrigger>
          <SelectContent position="popper">
            {permissionModes.map((item) => (
              <SelectItem key={item.id} value={item.id} title={item.description}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

/** The `/` command picker shown under the prompt while a command name is typed. */
export function SlashCommandMenu({ launch }: { launch: AgentLaunchOptionsState }) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [launch.slashIndex]);
  if (!launch.slashMenuOpen) {
    return null;
  }
  return (
    <ul
      aria-label="Slash commands"
      className="max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
    >
      {launch.slashMatches.map((command, index) => {
        const active = index === launch.slashIndex;
        return (
          <li key={command.name}>
            <button
              ref={active ? activeRef : undefined}
              type="button"
              aria-current={active}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left",
                active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
              onMouseEnter={() => launch.setSlashIndex(index)}
              // Keep focus in the editor so typing continues after a click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => launch.selectSlashCommand(command.name)}
            >
              <span className="shrink-0 font-mono">{command.invocation ?? `/${command.name}`}</span>
              {command.argumentHint ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {command.argumentHint}
                </span>
              ) : null}
              {command.description ? (
                <span className="truncate text-xs text-muted-foreground">
                  {command.description}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
