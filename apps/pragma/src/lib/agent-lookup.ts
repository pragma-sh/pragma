import type { AgentConfig } from "@/lib/tauri";

/**
 * The launchable agent a status report or message came from. Reporters use the
 * runtime id — the final segment of a catalog id (`pragma.codex` → `codex`) —
 * so match either form.
 */
export function findReportingAgent(
  agents: readonly AgentConfig[],
  reportAgent: string,
): AgentConfig | undefined {
  return (
    agents.find((agent) => agent.id === reportAgent) ??
    agents.find((agent) => agent.id.split(".").at(-1) === reportAgent)
  );
}

/** A reporting agent's display name, falling back to its raw id. */
export function reportingAgentName(agents: readonly AgentConfig[], reportAgent: string): string {
  return findReportingAgent(agents, reportAgent)?.name ?? reportAgent;
}
