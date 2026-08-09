/** A reasoning-effort choice offered by a model (e.g. Low / Medium / High). */
export interface MockReasoning {
  id: string;
  name: string;
}

/** A model an agent can run, with its optional reasoning-effort levels. */
export interface MockAgentModel {
  id: string;
  name: string;
  reasoning: MockReasoning[];
}

/** A configured coding agent and the models it exposes. */
export interface MockAgent {
  id: string;
  name: string;
  /** Emoji/glyph used as a lightweight agent icon (no icon font on mobile). */
  icon: string;
  models: MockAgentModel[];
}

/** A resolved agent + model (+ optional reasoning) selection. */
export interface AgentModelSelection {
  agentId: string;
  modelId: string;
  reasoningId: string | null;
}

/**
 * Front-end-only agent fixtures so the New Worktree sheet's agent picker has
 * something to show. Replaced by real agent config when the server is wired in.
 */
export const MOCK_AGENTS: MockAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    icon: "✳️",
    models: [
      {
        id: "opus-4-8",
        name: "Opus 4.8",
        reasoning: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      },
      { id: "sonnet-5", name: "Sonnet 5", reasoning: [] },
      { id: "haiku-4-5", name: "Haiku 4.5", reasoning: [] },
    ],
  },
  {
    id: "opencode",
    name: "opencode",
    icon: "◍",
    models: [
      {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: [
          { id: "minimal", name: "Minimal" },
          { id: "high", name: "High" },
        ],
      },
      { id: "grok-code", name: "Grok Code", reasoning: [] },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: "▹",
    models: [
      { id: "auto", name: "Auto", reasoning: [] },
      { id: "composer-1", name: "Composer 1", reasoning: [] },
    ],
  },
];

/** The default selection: first agent, its first model, no reasoning. */
export function defaultAgentSelection(
  agents: MockAgent[] = MOCK_AGENTS,
): AgentModelSelection | null {
  const agent = agents[0];
  const model = agent?.models[0];
  if (!agent || !model) return null;
  return { agentId: agent.id, modelId: model.id, reasoningId: null };
}

/** Human-readable "Agent / Model · Reasoning" label for a selection. */
export function agentSelectionLabel(
  selection: AgentModelSelection,
  agents: MockAgent[] = MOCK_AGENTS,
): { agent: MockAgent; model: MockAgentModel; reasoning: MockReasoning | null } | null {
  const agent = agents.find((a) => a.id === selection.agentId);
  const model = agent?.models.find((m) => m.id === selection.modelId);
  if (!agent || !model) return null;
  const reasoning = model.reasoning.find((r) => r.id === selection.reasoningId) ?? null;
  return { agent, model, reasoning };
}
