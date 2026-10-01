/**
 * Agent progress: estimate how far a running coding agent is through its task,
 * and what it is doing right now, with one System 1 request.
 *
 * The desktop calls this after every new message an agent reports on the rich
 * message stream (the same stream Pragma Go renders as chat). The System 1
 * model sees the task prompt and the agent's latest reply, and answers two
 * questions in parallel:
 *
 * - `progress` — a score over ordered progress levels, normalised to 0..1.
 * - `activity` — a choice among activity verbs (exploring, coding, …).
 *
 * The level descriptions and the verbs are passed in by the Rust bridge from
 * `@pragma-sh/constants` (`system1.agentProgress`), so the UI's labels and the
 * model's options can never drift apart.
 */
import {
  type ChoiceQuestion,
  evaluate,
  type ScoreQuestion,
  type Structured,
  type System1Endpoint,
} from "@pragma-sh/system1";

import { truncate, truncateStart } from "./truncate.ts";

/** One activity the model may choose; mirrors `AgentActivityOption` in the constants. */
export interface AgentProgressActivity {
  id: string;
  label: string;
  description: string;
}

/** Everything one estimate needs; the Rust bridge assembles it. */
export interface AgentProgressRequest {
  endpoint: System1Endpoint;
  /** Display name of the agent, e.g. `Claude Code`. */
  agent: string;
  /** The agent's live status, when known (`running`, `attention`, `done`). */
  status?: string | null;
  /** The task: the first prompt the agent was given. */
  prompt: string;
  /** The user's latest follow-up, when it differs from {@link prompt}. */
  followUp?: string | null;
  /** The newest message the agent wrote back. */
  lastMessage: string;
  /** Names of the tools the agent called most recently, newest last. */
  recentTools?: string[];
  activities: AgentProgressActivity[];
  /** Ordered progress descriptions, lowest first. */
  progressLevels: string[];
  limits: { promptChars: number; messageChars: number; timeoutMs: number };
}

/** The estimate, matching `AgentProgressEstimate` in the constants. */
export interface AgentProgressResult {
  /** Estimated fraction of the task complete, 0..1. */
  progress: number;
  /** Id of the chosen activity. */
  activity: string;
  /** Confidence of the activity choice. */
  confidence: number;
}

/** The request could not be built (as opposed to the System 1 request failing). */
export class AgentProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProgressError";
  }
}

/**
 * Parses the sidecar's stdin. The Rust bridge fills every structural field, so
 * a missing endpoint key, option list, or limits is a contract bug between the
 * two sides: fail loudly rather than guess.
 */
export function parseAgentProgressRequest(raw: string): AgentProgressRequest {
  const request = JSON.parse(raw) as Partial<AgentProgressRequest>;
  if (!request.endpoint?.apiKey || !request.limits) {
    throw new AgentProgressError("agent-progress needs endpoint and limits on stdin");
  }
  if ((request.activities?.length ?? 0) < 2 || (request.progressLevels?.length ?? 0) < 2) {
    throw new AgentProgressError("agent-progress needs at least two activities and levels");
  }
  return { agent: "agent", prompt: "", lastMessage: "", ...request } as AgentProgressRequest;
}

const PROGRESS_INSTRUCTIONS =
  "How much of the `task` has the coding agent completed? Judge from `latest_agent_message` and `recent_tools`: reading and planning is early, editing code is the middle, running tests or checks and summarising is late. A `follow_up` from the user narrows or extends the task.";

const ACTIVITY_INSTRUCTIONS =
  "What is the coding agent doing right now? Judge from `latest_agent_message` and `recent_tools`, not from the task.";

/** The state the System 1 model evaluates. */
function buildState(request: AgentProgressRequest): Structured {
  const { limits } = request;
  const followUp = request.followUp ? truncate(request.followUp, limits.promptChars) : "";
  const tools = request.recentTools ?? [];
  return {
    agent: request.agent,
    ...(request.status ? { status: request.status } : {}),
    task: truncate(request.prompt, limits.promptChars) || "(The task prompt is not available.)",
    ...(followUp ? { follow_up: followUp } : {}),
    latest_agent_message:
      truncateStart(request.lastMessage, limits.messageChars) || "(The agent has not replied yet.)",
    ...(tools.length > 0 ? { recent_tools: tools } : {}),
  };
}

function buildQuestions(request: AgentProgressRequest): {
  progress: ScoreQuestion;
  activity: ChoiceQuestion;
} {
  return {
    progress: {
      type: "score",
      instructions: PROGRESS_INSTRUCTIONS,
      criteria: request.progressLevels,
    },
    activity: {
      type: "choice",
      instructions: ACTIVITY_INSTRUCTIONS,
      criteria: Object.fromEntries(
        request.activities.map((activity) => [activity.id, activity.description]),
      ),
    },
  };
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Test seams for {@link estimateAgentProgress}. */
export interface AgentProgressDeps {
  fetch?: typeof fetch;
}

/**
 * Asks the System 1 model how far along the agent is and what it is doing.
 *
 * @throws {import("@pragma-sh/system1").System1Error} when the request fails.
 */
export async function estimateAgentProgress(
  request: AgentProgressRequest,
  deps: AgentProgressDeps = {},
): Promise<AgentProgressResult> {
  const result = await evaluate({
    endpoint: request.endpoint,
    state: buildState(request),
    questions: buildQuestions(request),
    signal: AbortSignal.timeout(request.limits.timeoutMs),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const { progress, activity } = result.answers;
  const known = request.activities.some((option) => option.id === activity.choice);
  return {
    progress: clampUnit(progress.score / (request.progressLevels.length - 1)),
    activity: known ? activity.choice : request.activities[0]!.id,
    confidence: clampUnit(activity.confidence),
  };
}
