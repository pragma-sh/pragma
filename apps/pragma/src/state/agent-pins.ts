import { createToggleSetStore } from "@/lib/external-set-store";

const store = createToggleSetStore("pragma.agentPins");

/** Returns whether an agent launcher is pinned. */
export function isAgentPinned(agentId: string): boolean {
  return store.has(agentId);
}

/** Toggles a persisted agent launcher pin. */
export function toggleAgentPin(agentId: string): void {
  store.toggle(agentId);
}

/** Returns agents with pinned ones first, preserving order within each group. */
export function sortAgentsByPin<T extends { id: string }>(
  agents: T[],
  pinned: ReadonlySet<string>,
): T[] {
  const top: T[] = [];
  const rest: T[] = [];
  for (const agent of agents) {
    (pinned.has(agent.id) ? top : rest).push(agent);
  }
  return [...top, ...rest];
}

/** React hook for the current pinned agent ids. */
export function useAgentPins(): ReadonlySet<string> {
  return store.useSnapshot();
}
