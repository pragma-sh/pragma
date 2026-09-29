/**
 * Auto mode: pick an agent, a model, and a reasoning effort for a launch with
 * one System 1 request.
 *
 * The request uses the "speculative fan-out" pattern: alongside the agent
 * choice it asks, for **every** candidate agent, which of that agent's models
 * fits — plus one difficulty score. All questions are evaluated in parallel, so
 * reading the model answer for whichever agent won costs no second round-trip.
 *
 * What the System 1 model sees:
 *
 * - `state` — the task prompt, where it will run, and the user's
 *   `automode.md` notes (project over global) with their stated priority.
 * - each agent option — its Terminal-Bench harness results (accuracy, time per
 *   task, tokens and cost per solved task), with a relative tier per axis.
 * - each model option — modelgrep benchmarks (intelligence, coding, speed,
 *   latency, price) and, when the leaderboard ran it, that model's result
 *   inside this harness.
 *
 * The `automode.md` include/exclude filters are applied here, in code, before
 * anything is sent: a hard rule is never left to a classifier's judgement.
 */
import {
  type ChoiceQuestion,
  evaluate,
  type Question,
  type ScoreQuestion,
  type Structured,
  type System1Endpoint,
} from "@pragma-sh/system1";

import {
  applyAutoModeFilters,
  shortAgentId,
  type AutoModePriority,
  mergeAutoMode,
  type MergedAutoModePreferences,
  parseAutoMode,
} from "./automode.ts";
import { AUTO_SELECT, HARNESS_INSIGHTS } from "./constants.ts";
import {
  type HarnessInsight,
  type HarnessInsights,
  loadHarnessInsights,
} from "./harness-insights.ts";
import {
  insightKey,
  loadModelInsights,
  type ModelInsight,
  type ModelInsights,
} from "./model-insights.ts";

/** One reasoning level, ordered lowest effort first in {@link AutoSelectModel.reasoning}. */
export interface AutoSelectReasoning {
  id: string;
  name: string;
}

/** A model an agent can launch with. */
export interface AutoSelectModel {
  id: string;
  name: string;
  /** Provider-qualified id for benchmark matching when `id` is an alias. */
  canonicalId?: string | null;
  reasoning: AutoSelectReasoning[];
}

/** A launchable agent and the models it offers. */
export interface AutoSelectAgent {
  id: string;
  name: string;
  models: AutoSelectModel[];
}

/** Everything one auto-select call needs; the Rust bridge assembles it. */
export interface AutoSelectRequest {
  endpoint: System1Endpoint;
  prompt: string;
  context: { project?: string | null; worktree?: string | null; branch?: string | null };
  agents: AutoSelectAgent[];
  /** Raw `automode.md` sources; `null` when the file does not exist. */
  automode: { global?: string | null; project?: string | null };
  limits: { promptChars: number; preferencesChars: number; timeoutMs: number };
}

/**
 * Parses the sidecar's stdin. The Rust bridge fills every field, so a missing
 * endpoint key, agent list, or limits is a contract bug between the two sides:
 * fail loudly rather than guess. Optional fields default to empty.
 */
export function parseAutoSelectRequest(raw: string): AutoSelectRequest {
  const request = JSON.parse(raw) as Partial<AutoSelectRequest>;
  const required = [request.endpoint?.apiKey, request.agents, request.limits];
  if (required.some((field) => !field)) {
    throw new AutoSelectError("auto-select needs endpoint, agents, and limits on stdin");
  }
  return { prompt: "", context: {}, automode: {}, ...request } as AutoSelectRequest;
}

/** The pick, with enough of the model's reasoning to explain it in the UI. */
export interface AutoSelectResult {
  agentId: string;
  modelId: string | null;
  reasoningId: string | null;
  /** Confidence of the agent choice (1 when there was only one candidate). */
  confidence: number;
  /** True when {@link confidence} is below `AUTO_SELECT.lowConfidence`. */
  lowConfidence: boolean;
  /** Estimated task difficulty, 0 (trivial) to 1 (very hard). */
  difficulty: number;
  agentProbabilities: Record<string, number>;
  /** Probabilities over the chosen agent's models. */
  modelProbabilities: Record<string, number>;
  /** One-line human explanation, e.g. `Codex 72% · GPT-6 Astra 64% · hard task → High`. */
  reason: string;
  /** Problems in `automode.md` the user should fix. */
  warnings: string[];
  /** Which benchmark feeds contributed. */
  sources: { modelBenchmarks: boolean; harnessBenchmarks: boolean };
}

/** Auto mode could not run (as opposed to the System 1 request failing). */
export class AutoSelectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoSelectError";
  }
}

/** Benchmark feeds, injectable so tests never touch the network. */
export interface AutoSelectInsights {
  models: ModelInsights;
  harness: HarnessInsights;
}

/** Test seams for {@link autoSelect}. */
export interface AutoSelectDeps {
  loadInsights?: () => Promise<AutoSelectInsights>;
  fetch?: typeof fetch;
}

/** Difficulty levels, easiest first; the score's index maps onto reasoning effort. */
export const DIFFICULTY_LEVELS = [
  "Trivial: a one-line, mechanical, or purely informational change",
  "Small: a focused change in one or two files",
  "Moderate: a multi-file feature or an ordinary bug fix",
  "Hard: a cross-cutting refactor, tricky debugging, or design work",
  "Very hard: large, ambiguous, research-heavy, or high-stakes work",
] as const;

const DIFFICULTY_NAMES = ["trivial", "small", "moderate", "hard", "very hard"] as const;

const PRIORITY_GUIDANCE: Record<AutoModePriority, string> = {
  accuracy: "The user values getting it right over speed and cost.",
  speed:
    "The user values fast turnaround; prefer quicker harnesses and models when capable enough.",
  efficiency: "The user values token and cost efficiency; avoid spending more than the task needs.",
  balanced: "The user wants a balance of accuracy, speed, and cost.",
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Lowercase alphanumerics only — `Claude Code` and `claude-code` compare equal. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Exact, or one key is a suffix of the other (`claudeopus5` ~ `opus5`), with a floor. */
function keysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.endsWith(short);
}

/** Whether a leaderboard harness label names this agent. */
export function harnessMatchesAgent(harness: string, agent: { id: string; name: string }): boolean {
  const key = compact(harness);
  return [agent.name, agent.id].some((candidate) => {
    const other = compact(candidate);
    if (!key || !other) return false;
    if (key === other) return true;
    const [short, long] = key.length < other.length ? [key, other] : [other, key];
    return short.length >= 4 && long.startsWith(short);
  });
}

function modelKeys(model: AutoSelectModel): string[] {
  return [model.canonicalId, model.id, model.name]
    .filter((value): value is string => Boolean(value))
    .map(insightKey);
}

/** Whether a leaderboard row ran this model. */
export function rowMatchesModel(row: HarnessInsight, model: AutoSelectModel): boolean {
  const rowKeys = [row.modelSlug, row.model]
    .filter((value): value is string => Boolean(value))
    .map(insightKey);
  return modelKeys(model).some((key) => rowKeys.some((rowKey) => keysMatch(key, rowKey)));
}

/** modelgrep insight for a model, trying its canonical id, id, then name. */
export function modelInsightFor(
  insights: ModelInsights,
  model: AutoSelectModel,
): ModelInsight | undefined {
  for (const key of modelKeys(model)) {
    const exact = insights.get(key);
    if (exact) return exact;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Where a value sits among its peers. */
export type Tier = "best" | "above median" | "below median" | "worst" | "only one measured";

/** Ranks `value` among `values`, flipping direction for lower-is-better metrics. */
export function tier(value: number, values: readonly number[], higherIsBetter: boolean): Tier {
  if (values.length < 2) return "only one measured";
  const sorted = values.toSorted((a, b) => (higherIsBetter ? b - a : a - b));
  if (value === sorted[0]) return "best";
  if (value === sorted.at(-1)) return "worst";
  const middle = sorted.length / 2;
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? value) + (sorted[middle] ?? value)) / 2
      : (sorted[Math.floor(middle)] ?? value);
  const better = higherIsBetter ? value >= median : value <= median;
  return better ? "above median" : "below median";
}

const round = (value: number, places = 1) => Number(value.toFixed(places));

function harnessRowSummary(row: HarnessInsight): Record<string, unknown> {
  return {
    model: row.model,
    reasoning_effort: row.reasoningEffort ?? "unreported",
    accuracy_pct: round(row.accuracy),
    ...(row.accuracyCi95 === null ? {} : { accuracy_ci95_pct: round(row.accuracyCi95) }),
    ...(row.avgTaskSeconds === null
      ? {}
      : { avg_minutes_per_task: round(row.avgTaskSeconds / 60) }),
    ...(row.tokensPerSolve === null
      ? {}
      : { million_tokens_per_solved_task: round(row.tokensPerSolve / 1e6, 2) }),
    ...(row.costPerSolveUsd === null ? {} : { usd_per_solved_task: round(row.costPerSolveUsd, 2) }),
  };
}

/** An agent's best leaderboard result per axis, used for cross-agent tiers. */
interface AgentHarnessStats {
  accuracy: number;
  minutes: number | null;
  tokens: number | null;
}

/** The smallest present value, or `null` when none was measured. */
function lowest(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

/** Leaderboard rows, best accuracy first. */
function byAccuracy(rows: readonly HarnessInsight[]): HarnessInsight[] {
  return rows.toSorted((a, b) => b.accuracy - a.accuracy);
}

function agentStats(rows: readonly HarnessInsight[]): AgentHarnessStats | null {
  if (rows.length === 0) return null;
  return {
    accuracy: Math.max(...rows.map((row) => row.accuracy)),
    minutes: lowest(
      rows.map((row) => (row.avgTaskSeconds === null ? null : row.avgTaskSeconds / 60)),
    ),
    tokens: lowest(rows.map((row) => row.tokensPerSolve)),
  };
}

function statTiers(
  stats: AgentHarnessStats,
  all: readonly AgentHarnessStats[],
): Record<string, Tier> {
  const present = (select: (s: AgentHarnessStats) => number | null) =>
    all.map(select).filter((value): value is number => value !== null);
  return {
    accuracy: tier(
      stats.accuracy,
      present((s) => s.accuracy),
      true,
    ),
    ...(stats.minutes === null
      ? {}
      : {
          speed: tier(
            stats.minutes,
            present((s) => s.minutes),
            false,
          ),
        }),
    ...(stats.tokens === null
      ? {}
      : {
          token_efficiency: tier(
            stats.tokens,
            present((s) => s.tokens),
            false,
          ),
        }),
  };
}

/** An agent option's description: its harness results and its models. */
function agentCriterion(
  agent: AutoSelectAgent,
  rows: readonly HarnessInsight[],
  allStats: readonly AgentHarnessStats[],
): Record<string, unknown> {
  const stats = agentStats(rows);
  return {
    name: agent.name,
    models: agent.models.slice(0, 12).map((model) => model.name),
    harness_benchmarks: stats
      ? {
          source: HARNESS_INSIGHTS.sourceLabel,
          versus_other_harnesses: statTiers(stats, allStats),
          results: byAccuracy(rows)
            .slice(0, AUTO_SELECT.maxHarnessRowsPerAgent)
            .map(harnessRowSummary),
        }
      : "No harness benchmark data. Judge it by its models and the user's notes.",
  };
}

function blendedPrice(insight: ModelInsight): number | null {
  if (insight.costInput === null || insight.costOutput === null) return null;
  return insight.costInput + insight.costOutput;
}

function modelBenchmarks(insight: ModelInsight | undefined): Record<string, unknown> | string {
  if (!insight) return "No benchmark data.";
  const price = blendedPrice(insight);
  const entries: [string, number | null][] = [
    ["intelligence_index", insight.intelligence],
    ["coding_index", insight.coding],
    ["output_tokens_per_second", insight.throughputTps],
    ["time_to_first_token_ms", insight.latencyMs],
    ["usd_per_million_tokens_in_plus_out", price === null ? null : round(price, 2)],
  ];
  const present = entries.filter((entry): entry is [string, number] => entry[1] !== null);
  return present.length > 0 ? Object.fromEntries(present) : "No benchmark data.";
}

interface ProfiledModel {
  model: AutoSelectModel;
  insight: ModelInsight | undefined;
  harness: HarnessInsight | undefined;
}

/**
 * Profiles an agent's models and trims the list to `maxModelsPerAgent`,
 * keeping benchmarked models first (best coding score first) so an OpenCode
 * catalog of hundreds cannot crowd out the models worth choosing.
 */
function profileModels(
  agent: AutoSelectAgent,
  rows: readonly HarnessInsight[],
  insights: ModelInsights,
): ProfiledModel[] {
  const ranked = byAccuracy(rows);
  const profiled = agent.models.map((model) => ({
    model,
    insight: modelInsightFor(insights, model),
    harness: ranked.find((row) => rowMatchesModel(row, model)),
  }));
  if (profiled.length <= AUTO_SELECT.maxModelsPerAgent) return profiled;
  return profiled
    .toSorted((a, b) => evidenceScore(b) - evidenceScore(a))
    .slice(0, AUTO_SELECT.maxModelsPerAgent);
}

/** Ranks a model by how much we know about it: a harness result beats any model score. */
function evidenceScore(entry: ProfiledModel): number {
  if (entry.harness) return 1_000 + entry.harness.accuracy;
  return entry.insight?.coding ?? entry.insight?.intelligence ?? -1;
}

function modelCriterion(entry: ProfiledModel): Record<string, unknown> {
  return {
    name: entry.model.name,
    benchmarks: modelBenchmarks(entry.insight),
    ...(entry.harness ? { result_in_this_harness: harnessRowSummary(entry.harness) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…(truncated)` : trimmed;
}

function buildState(
  request: AutoSelectRequest,
  preferences: MergedAutoModePreferences,
): Structured {
  const { limits, context } = request;
  const prompt = truncate(request.prompt, limits.promptChars);
  return {
    task: prompt || "(No prompt was written. Choose the best general default for this project.)",
    where: {
      ...(context.project ? { project: context.project } : {}),
      ...(context.worktree ? { worktree: context.worktree } : {}),
      ...(context.branch ? { branch: context.branch } : {}),
    },
    user_preferences: {
      rule: "These are the user's own instructions. Follow them whenever they apply to the task. Project notes override global notes.",
      ...(preferences.priority ? { priority: PRIORITY_GUIDANCE[preferences.priority] } : {}),
      project_notes: truncate(preferences.notes.project, limits.preferencesChars) || "(none)",
      global_notes: truncate(preferences.notes.global, limits.preferencesChars) || "(none)",
    },
  };
}

const AGENT_INSTRUCTIONS =
  "Which coding-agent harness should run the `task`? Apply `user_preferences` first. Otherwise match the task to the harness: favour benchmark accuracy for hard or high-stakes work, speed for small or mechanical changes, and token efficiency when accuracy is close.";

const MODEL_INSTRUCTIONS =
  "Which model should `agent` use for the `task`? Apply `user_preferences` first. Otherwise favour capability (coding and intelligence) for hard work, fast and inexpensive models for small or mechanical work, and the harness result when one is shown.";

/** One planned question per agent that has a real model choice. */
interface ModelQuestionPlan {
  questionId: string;
  agent: AutoSelectAgent;
  models: ProfiledModel[];
}

interface RequestPlan {
  questions: Record<string, Question>;
  modelQuestions: ModelQuestionPlan[];
}

function buildPlan(agents: readonly AutoSelectAgent[], insights: AutoSelectInsights): RequestPlan {
  const rowsByAgent = agents.map((agent) =>
    insights.harness.filter((row) => harnessMatchesAgent(row.agent, agent)),
  );
  const allStats = rowsByAgent
    .map(agentStats)
    .filter((stats): stats is AgentHarnessStats => stats !== null);

  const questions: Record<string, Question> = {
    difficulty: {
      type: "score",
      instructions: "How difficult is the `task` for a coding agent?",
      criteria: [...DIFFICULTY_LEVELS],
    } satisfies ScoreQuestion,
  };
  if (agents.length > 1) {
    questions.agent = {
      type: "choice",
      instructions: AGENT_INSTRUCTIONS,
      criteria: Object.fromEntries(
        agents.map((agent, index) => [
          agent.id,
          agentCriterion(agent, rowsByAgent[index] ?? [], allStats),
        ]),
      ),
    } satisfies ChoiceQuestion;
  }

  const modelQuestions: ModelQuestionPlan[] = [];
  agents.forEach((agent, index) => {
    const models = profileModels(agent, rowsByAgent[index] ?? [], insights.models);
    if (models.length < 2) return;
    const questionId = `model_${index}`;
    modelQuestions.push({ questionId, agent, models });
    questions[questionId] = {
      type: "choice",
      instructions: { question: MODEL_INSTRUCTIONS, agent: agent.name },
      criteria: Object.fromEntries(models.map((entry) => [entry.model.id, modelCriterion(entry)])),
    } satisfies ChoiceQuestion;
  });
  return { questions, modelQuestions };
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/** Maps a 0–1 difficulty onto a model's reasoning levels (ordered lowest first). */
export function reasoningForDifficulty(
  levels: readonly AutoSelectReasoning[],
  difficulty: number,
): AutoSelectReasoning | null {
  if (levels.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, difficulty));
  return levels[Math.round(clamped * (levels.length - 1))] ?? null;
}

function difficultyName(difficulty: number): string {
  const index = Math.round(difficulty * (DIFFICULTY_NAMES.length - 1));
  return DIFFICULTY_NAMES[index] ?? "moderate";
}

function percent(probability: number | undefined): string {
  return `${Math.round((probability ?? 0) * 100)}%`;
}

function buildReason(
  agent: AutoSelectAgent,
  model: AutoSelectModel | null,
  reasoning: AutoSelectReasoning | null,
  probabilities: { agent: Record<string, number>; model: Record<string, number> },
  difficulty: number,
): string {
  const parts = [
    Object.keys(probabilities.agent).length > 1
      ? `${agent.name} ${percent(probabilities.agent[agent.id])}`
      : agent.name,
  ];
  if (model) {
    parts.push(
      Object.keys(probabilities.model).length > 1
        ? `${model.name} ${percent(probabilities.model[model.id])}`
        : model.name,
    );
  }
  const task = `${difficultyName(difficulty)} task`;
  parts.push(reasoning ? `${task} → ${reasoning.name}` : task);
  return parts.join(" · ");
}

async function defaultInsights(): Promise<AutoSelectInsights> {
  const [models, harness] = await Promise.all([loadModelInsights(), loadHarnessInsights()]);
  return { models, harness };
}

function prefixed(scope: string, warnings: readonly string[]): string[] {
  return warnings.map((warning) => `${scope} automode.md: ${warning}`);
}

function candidateAgents(request: AutoSelectRequest): {
  agents: AutoSelectAgent[];
  preferences: MergedAutoModePreferences;
  warnings: string[];
} {
  if (request.agents.length === 0)
    throw new AutoSelectError("No agents are available to choose from.");
  const global = parseAutoMode(request.automode.global);
  const project = parseAutoMode(request.automode.project);
  const preferences = mergeAutoMode(global.preferences, project.preferences);
  const agents = applyAutoModeFilters(request.agents, preferences);
  if (agents.length === 0) {
    const names = request.agents.map((agent) => shortAgentId(agent.id)).join(", ");
    throw new AutoSelectError(
      `Every agent is excluded by automode.md — loosen its filters. Available agents: ${names}.`,
    );
  }
  return {
    agents,
    preferences,
    warnings: [...prefixed("project", project.warnings), ...prefixed("global", global.warnings)],
  };
}

function chosenModel(
  plan: RequestPlan,
  agent: AutoSelectAgent,
  answers: Record<string, { choice?: string; probabilities?: Record<string, number> }>,
): { model: AutoSelectModel | null; probabilities: Record<string, number> } {
  const question = plan.modelQuestions.find((entry) => entry.agent.id === agent.id);
  if (!question) return { model: agent.models[0] ?? null, probabilities: {} };
  const answer = answers[question.questionId];
  const model = agent.models.find((candidate) => candidate.id === answer?.choice) ?? null;
  return {
    model: model ?? question.models[0]?.model ?? null,
    probabilities: answer?.probabilities ?? {},
  };
}

/**
 * Runs auto mode end to end: filter by `automode.md`, gather benchmarks, ask
 * the System 1 model, and map its answers onto a launchable selection.
 *
 * @throws {AutoSelectError} when no candidate survives the filters.
 * @throws {import("@pragma-sh/system1").System1Error} when the request fails.
 */
export async function autoSelect(
  request: AutoSelectRequest,
  deps: AutoSelectDeps = {},
): Promise<AutoSelectResult> {
  const { agents, preferences, warnings } = candidateAgents(request);
  const insights = await (deps.loadInsights ?? defaultInsights)();
  const plan = buildPlan(agents, insights);

  const result = await evaluate({
    endpoint: request.endpoint,
    state: buildState(request, preferences),
    questions: plan.questions,
    signal: AbortSignal.timeout(request.limits.timeoutMs),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const answers = result.answers as Record<
    string,
    { choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number }
  >;

  const agentAnswer = answers.agent;
  const agent = agents.find((candidate) => candidate.id === agentAnswer?.choice) ?? agents[0]!;
  const confidence = agentAnswer?.confidence ?? 1;
  const difficulty = (answers.difficulty?.score ?? 2) / (DIFFICULTY_LEVELS.length - 1);
  const { model, probabilities: modelProbabilities } = chosenModel(plan, agent, answers);
  const reasoning = model ? reasoningForDifficulty(model.reasoning, difficulty) : null;
  const agentProbabilities = agentAnswer?.probabilities ?? { [agent.id]: 1 };

  return {
    agentId: agent.id,
    modelId: model?.id ?? null,
    reasoningId: reasoning?.id ?? null,
    confidence,
    lowConfidence: confidence < AUTO_SELECT.lowConfidence,
    difficulty,
    agentProbabilities,
    modelProbabilities,
    reason: buildReason(
      agent,
      model,
      reasoning,
      { agent: agentProbabilities, model: modelProbabilities },
      difficulty,
    ),
    warnings,
    sources: {
      modelBenchmarks: insights.models.size > 0,
      harnessBenchmarks: insights.harness.length > 0,
    },
  };
}
