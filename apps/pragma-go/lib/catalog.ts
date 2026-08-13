import type { CatalogAgent } from "@pragma/sdk";

import type { MockAgent } from "./data/agents";

/** Converts host catalog entries into the selector's agent/model tree. */
export function catalogToSelectorAgents(agents: CatalogAgent[]): MockAgent[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    icon: "◆",
    models: agent.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: (model.reasoning ?? []).map((reasoning) => ({
        id: reasoning.id,
        name: reasoning.name,
      })),
    })),
  }));
}
