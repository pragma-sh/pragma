import type { LockedPlugin } from "@pragma/plugin-registry";

import type { PluginRecord } from "@/plugins/registry";

export const AGENT_COMMAND_SUBMITTED_EVENT = "pragma:agent-command-submitted";

export interface AgentCommandSubmittedDetail {
  command: string;
}

/** Announces a shell command submitted through an interactive Pragma terminal. */
export function announceSubmittedCommand(command: string): void {
  window.dispatchEvent(
    new CustomEvent<AgentCommandSubmittedDetail>(AGENT_COMMAND_SUBMITTED_EVENT, {
      detail: { command },
    }),
  );
}

/** Finds an official agent plugin whose bundled launcher matches a submitted command. */
export function missingAgentPluginForCommand(
  command: string,
  activePlugins: readonly PluginRecord[],
  officialPlugins: readonly LockedPlugin[],
): LockedPlugin | null {
  const executable = submittedExecutable(command);
  if (!executable) return null;

  const record = activePlugins.find(
    (plugin) =>
      plugin.scope === "bundled" &&
      plugin.status === "loaded" &&
      plugin.definition?.agents?.some(
        (agent) => executableName(agent.launch.command[0]) === executable,
      ),
  );
  if (!record) return null;

  return (
    officialPlugins.find((plugin) => executableName(plugin.manifest.agentBinary) === executable) ??
    null
  );
}

function submittedExecutable(command: string): string | null {
  const firstToken = command.trimStart().match(/^[^\s;&|]+/)?.[0];
  return executableName(firstToken);
}

function executableName(value: string | undefined): string | null {
  const unquoted = value?.replace(/^(['"])(.*)\1$/, "$2");
  return unquoted?.split(/[\\/]/).at(-1) ?? null;
}
