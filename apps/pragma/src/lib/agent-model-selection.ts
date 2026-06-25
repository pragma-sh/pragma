import type { AgentConfig, AgentModel, AgentModelSelection } from "@/lib/tauri";

const STORAGE_PREFIX = "pragma:agent-model-selection:";

/** Empty model selection: launch without appending model or reasoning args. */
export const EMPTY_MODEL_SELECTION: AgentModelSelection = { modelId: null, reasoningId: null };

/** Returns a remembered valid model selection for an agent, otherwise the first model. */
export function defaultModelSelection(agentId: string, models: AgentModel[]): AgentModelSelection {
  const remembered = validateModelSelection(models, readRememberedModelSelection(agentId));
  if (remembered.modelId || models.length === 0) {
    return remembered;
  }
  return { modelId: models[0]!.id, reasoningId: null };
}

/** Persists the latest model/reasoning selection for an agent. */
export function rememberModelSelection(agentId: string, selection: AgentModelSelection): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${agentId}`, JSON.stringify(selection));
  } catch {
    // Cosmetic preference only; private-mode/localStorage failures should not block launch.
  }
}

/** Validates a requested model/reasoning selection, falling back to no model on mismatch. */
export function validateModelSelection(
  models: AgentModel[],
  selection: AgentModelSelection | null | undefined,
): AgentModelSelection {
  if (!selection?.modelId) {
    return EMPTY_MODEL_SELECTION;
  }
  const model = models.find((item) => item.id === selection.modelId);
  if (!model) {
    return EMPTY_MODEL_SELECTION;
  }
  if (!selection.reasoningId) {
    return { modelId: model.id, reasoningId: null };
  }
  const reasoning = model.reasoning.find((item) => item.id === selection.reasoningId);
  return reasoning ? { modelId: model.id, reasoningId: reasoning.id } : EMPTY_MODEL_SELECTION;
}

/** Human-readable selection label for compact triggers and tests. */
export function modelSelectionLabel(models: AgentModel[], selection: AgentModelSelection): string {
  if (!selection.modelId) {
    return "Select model";
  }
  const model = models.find((item) => item.id === selection.modelId);
  if (!model) {
    return "Select model";
  }
  if (!selection.reasoningId) {
    return model.name;
  }
  const reasoning = model.reasoning.find((item) => item.id === selection.reasoningId);
  return reasoning ? `${model.name} · ${reasoning.name}` : model.name;
}

/** Builds the argv appended to an agent's configured `start` argv for a selected model. */
export function modelLaunchArgs(
  agent: AgentConfig,
  selection: AgentModelSelection | null | undefined,
): string[] {
  if (!selection?.modelId || !agent.models) {
    return [];
  }
  const model = selection.modelId;
  const reasoning = selection.reasoningId;
  if (reasoning && agent.models.modelReasoningArg) {
    return interpolateArgs(agent.models.modelReasoningArg, model, reasoning);
  }
  const args = agent.models.modelArg
    ? interpolateArgs(agent.models.modelArg, model, reasoning)
    : [];
  if (reasoning && agent.models.reasoningArg) {
    args.push(...interpolateArgs(agent.models.reasoningArg, model, reasoning));
  }
  return args;
}

/** Resolves explicit or compact deep-link selectors against loaded model metadata. */
export function resolveDeepLinkAgentSelection(
  request: { agentId: string | null; modelId?: string | null; reasoningId?: string | null },
  agents: AgentConfig[],
  modelsByAgent: Record<string, AgentModel[] | undefined>,
): { agentId: string | null; selection: AgentModelSelection } {
  if (!request.agentId) {
    return { agentId: null, selection: EMPTY_MODEL_SELECTION };
  }
  const match = matchAgentSelector(request.agentId, agents);
  if (!match) {
    return { agentId: null, selection: EMPTY_MODEL_SELECTION };
  }
  const models = modelsByAgent[match.agent.id] ?? [];
  if (request.modelId) {
    return {
      agentId: match.agent.id,
      selection: validateModelSelection(models, {
        modelId: request.modelId,
        reasoningId: request.reasoningId ?? null,
      }),
    };
  }
  if (!match.remaining) {
    return { agentId: match.agent.id, selection: EMPTY_MODEL_SELECTION };
  }
  const exactModel = models.find((item) => item.id === match.remaining);
  if (exactModel) {
    return { agentId: match.agent.id, selection: { modelId: exactModel.id, reasoningId: null } };
  }
  const lastDot = match.remaining.lastIndexOf(".");
  if (lastDot === -1) {
    return { agentId: match.agent.id, selection: EMPTY_MODEL_SELECTION };
  }
  const modelId = match.remaining.slice(0, lastDot);
  const reasoningId = match.remaining.slice(lastDot + 1);
  return {
    agentId: match.agent.id,
    selection: validateModelSelection(models, { modelId, reasoningId }),
  };
}

function readRememberedModelSelection(agentId: string): AgentModelSelection | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${agentId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AgentModelSelection>;
    return {
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
      reasoningId: typeof parsed.reasoningId === "string" ? parsed.reasoningId : null,
    };
  } catch {
    return null;
  }
}

function interpolateArgs(args: string[], model: string, reasoning: string | null): string[] {
  return args.map((arg) =>
    arg.replaceAll("{model}", model).replaceAll("{reasoning}", reasoning ?? ""),
  );
}

function matchAgentSelector(selector: string, agents: AgentConfig[]) {
  const sorted = agents.toSorted((a, b) => b.id.length - a.id.length);
  for (const agent of sorted) {
    if (selector === agent.id) {
      return { agent, remaining: "" };
    }
    const prefix = `${agent.id}.`;
    if (selector.startsWith(prefix)) {
      return { agent, remaining: selector.slice(prefix.length) };
    }
  }
  return null;
}
