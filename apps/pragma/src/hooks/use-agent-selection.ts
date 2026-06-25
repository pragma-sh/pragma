import { useEffect, useRef, useState } from "react";

import { useAgentModels } from "@/hooks/use-agent-models";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
  validateModelSelection,
} from "@/lib/agent-model-selection";
import {
  type AgentConfig,
  type AgentModel,
  type AgentModelSelection,
  listAgents,
} from "@/lib/tauri";

/** Agent + model picking shared by the agent-launch dialogs. */
export interface AgentSelection {
  agents: AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  agentId: string | null;
  modelSelection: AgentModelSelection;
  /** The currently chosen agent, or `null` until one resolves. */
  selectedAgent: AgentConfig | null;
  /** Lazily loads an agent's models (e.g. when its submenu is hovered). */
  loadModels: (agentId: string) => void;
  /** Selects an agent + model and remembers it for next time. */
  handleAgentChange: (agentId: string, selection: AgentModelSelection) => void;
}

/**
 * Loads the configured agents and tracks the chosen agent + model selection,
 * keeping a valid agent selected (falling back to the first/default) and syncing
 * the model selection whenever the agent or its resolved models change. Only
 * fetches while `active` (a dialog being open), so closed dialogs stay idle.
 */
export function useAgentSelection(active: boolean): AgentSelection {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const previousAgentIdRef = useRef<string | null>(null);

  // Load the configured agents whenever the consumer becomes active.
  useEffect(() => {
    if (!active) {
      return;
    }
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
  }, [active]);

  // Show already-resolved models immediately, without waiting for a hover.
  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  // Keep a valid agent selected, falling back to the first (default) agent.
  useEffect(() => {
    if (!active || agents.length === 0) {
      return;
    }
    setAgentId((current) =>
      current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id,
    );
  }, [active, agents]);

  // Sync the model selection when the agent (or its resolved models) changes.
  useEffect(() => {
    if (!active || !agentId) {
      return;
    }
    const models = modelsByAgent[agentId];
    if (!models) {
      return;
    }
    const changedAgent = previousAgentIdRef.current !== agentId;
    previousAgentIdRef.current = agentId;
    setModelSelection((current) => {
      if (changedAgent) {
        return defaultModelSelection(agentId, models);
      }
      const valid = validateModelSelection(models, current);
      return valid.modelId === null && current.modelId !== null
        ? defaultModelSelection(agentId, models)
        : valid;
    });
  }, [active, agentId, modelsByAgent]);

  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;

  function handleAgentChange(nextAgentId: string, nextSelection: AgentModelSelection) {
    setAgentId(nextAgentId);
    setModelSelection(nextSelection);
    rememberModelSelection(nextAgentId, nextSelection);
  }

  return {
    agents,
    modelsByAgent,
    agentId,
    modelSelection,
    selectedAgent,
    loadModels,
    handleAgentChange,
  };
}
