/**
 * `@pragma-sh/system1` — a typed client for System 1 models: TypeSafe's Jev and
 * any API that speaks the same `systemone` evaluation contract.
 *
 * A System 1 model does not generate text. It evaluates a `state` against named,
 * typed questions and answers each with calibrated probabilities:
 *
 * - **noul** — a yes/no question; the answer is the probability of "yes".
 * - **choice** — pick one option from a set (at most {@link MAX_CHOICE_OPTIONS}).
 * - **score** — rate the state on ordered levels (at most {@link MAX_SCORE_LEVELS}).
 *
 * Every question in one request is evaluated in parallel and in isolation, so
 * asking several at once costs one round-trip. See https://docs.typesafe.ai/api.
 *
 * This package knows nothing about Pragma's settings, credentials, or agents —
 * callers hand it a base URL and a key. It is dependency-free and runs anywhere
 * the platform `fetch` does.
 */

/** Largest option set a single choice question accepts. */
export const MAX_CHOICE_OPTIONS = 255;
/** Largest level list a single score question accepts. */
export const MAX_SCORE_LEVELS = 10;

/** Free-form structured text: the API accepts a string, an object, or an array. */
export type Structured = string | Record<string, unknown> | unknown[];

/** A yes/no question. */
export interface NoulQuestion {
  type: "noul";
  instructions: Structured;
  criteria?: { true?: Structured; false?: Structured };
}

/** Pick one option. `criteria` maps each option key to its description (or `null`). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: Structured;
  criteria: Record<string, Structured | null>;
}

/** Rate the state on ordered levels, lowest first. */
export interface ScoreQuestion {
  type: "score";
  instructions: Structured;
  criteria: Structured[];
}

/** Any question the evaluation endpoint accepts. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Answer to a {@link NoulQuestion}: `noul` is the probability of "yes". */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

/** Answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Answer to a {@link ScoreQuestion}; `score` is probability-weighted and may fall between levels. */
export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Any answer the evaluation endpoint returns. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Maps each question type to its answer type. */
type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer
    : ScoreAnswer;

/** Answers keyed by the ids the questions were asked under. */
export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** One evaluation response. */
export interface EvaluateResult<Q extends Record<string, Question>> {
  /** Resolved model version, e.g. `jev-1.13.0`. */
  model: string;
  answers: Answers<Q>;
  usage: { inputTokens: number; outputTokens: number };
}

/** Where and as whom to evaluate. */
export interface System1Endpoint {
  /** API origin, e.g. `https://api.typesafe.ai`. A trailing slash is tolerated. */
  baseUrl: string;
  /** Endpoint path appended to `baseUrl`, e.g. `/v1/systemone`. */
  evaluatePath: string;
  apiKey: string;
  /** Model route, e.g. `jev-latest`. */
  model: string;
}

/** Options for {@link evaluate}. */
export interface EvaluateOptions<Q extends Record<string, Question>> {
  endpoint: System1Endpoint;
  state: Structured;
  questions: Q;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}

/** Why a System 1 request failed, so callers can message it precisely. */
export type System1ErrorKind =
  | "auth"
  | "rate-limit"
  | "bad-request"
  | "server"
  | "network"
  | "timeout"
  | "invalid-response";

/** A failed System 1 request. `status` is the HTTP status when there was one. */
export class System1Error extends Error {
  constructor(
    readonly kind: System1ErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "System1Error";
  }
}

/**
 * Last path segments that name an evaluation endpoint outright: TypeSafe's
 * `/v1/systemone` and OpenRouter's `/api/alpha/decisions`.
 */
const ENDPOINT_SEGMENTS = new Set(["systemone", "decisions"]);

/**
 * Resolves the request URL. `baseUrl` is usually an origin (`https://api.typesafe.ai`)
 * that `path` is appended to, but users also paste a full endpoint URL
 * (`https://openrouter.ai/api/alpha/decisions`); one that already ends in an
 * endpoint segment is used as-is rather than having the path appended again.
 */
export function endpointUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const last = base.split("/").at(-1)?.toLowerCase() ?? "";
  if (ENDPOINT_SEGMENTS.has(last)) return base;
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function statusKind(status: number): System1ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "bad-request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return out;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validates one raw answer against the type of the question it answers. */
export function parseAnswer(question: Question, raw: unknown): Answer | null {
  if (!isRecord(raw) || raw.type !== question.type) return null;
  return ANSWER_PARSERS[question.type](raw);
}

function parseNoul(raw: Record<string, unknown>): NoulAnswer | null {
  const noul = finite(raw.noul);
  return noul === null ? null : { type: "noul", noul };
}

/** The distribution every choice and score answer carries. */
function distribution(
  raw: Record<string, unknown>,
): { probabilities: Record<string, number>; confidence: number } | null {
  const probabilities = numberRecord(raw.probabilities);
  const confidence = finite(raw.confidence);
  return probabilities && confidence !== null ? { probabilities, confidence } : null;
}

function parseChoice(raw: Record<string, unknown>): ChoiceAnswer | null {
  const spread = distribution(raw);
  if (!spread || typeof raw.choice !== "string") return null;
  return { type: "choice", choice: raw.choice, ...spread };
}

function parseScore(raw: Record<string, unknown>): ScoreAnswer | null {
  const spread = distribution(raw);
  const score = finite(raw.score);
  if (!spread || score === null) return null;
  return { type: "score", score, ...spread };
}

const ANSWER_PARSERS: Record<Question["type"], (raw: Record<string, unknown>) => Answer | null> = {
  noul: parseNoul,
  choice: parseChoice,
  score: parseScore,
};

function parseUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  const usage = isRecord(raw) ? raw : {};
  return {
    inputTokens: finite(usage.input_tokens) ?? 0,
    outputTokens: finite(usage.output_tokens) ?? 0,
  };
}

/** Parses a response body, rejecting any answer that is missing or mistyped. */
export function parseEvaluateResponse<Q extends Record<string, Question>>(
  questions: Q,
  body: unknown,
): EvaluateResult<Q> {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new System1Error("invalid-response", "System 1 response has no answers");
  }
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseAnswer(question, body.answers[id]);
    if (!answer) {
      throw new System1Error("invalid-response", `System 1 answer "${id}" is missing or malformed`);
    }
    answers[id] = answer;
  }
  return {
    model: typeof body.model === "string" ? body.model : "",
    answers: answers as Answers<Q>,
    usage: parseUsage(body.usage),
  };
}

function validateQuestions(questions: Record<string, Question>): void {
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const count = Object.keys(question.criteria).length;
      if (count === 0 || count > MAX_CHOICE_OPTIONS) {
        throw new System1Error(
          "bad-request",
          `choice "${id}" needs 1-${MAX_CHOICE_OPTIONS} options, got ${count}`,
        );
      }
    }
    if (question.type === "score") {
      const count = question.criteria.length;
      if (count < 2 || count > MAX_SCORE_LEVELS) {
        throw new System1Error(
          "bad-request",
          `score "${id}" needs 2-${MAX_SCORE_LEVELS} levels, got ${count}`,
        );
      }
    }
  }
}

/** A human message from `"text"` or `{ message: "text" }`, else `null`. */
function messageOf(value: unknown): string | null {
  const message = isRecord(value) ? value.message : value;
  return typeof message === "string" && message ? message : null;
}

/**
 * Reads the error body. TypeSafe answers `{ detail: { message } }`; other
 * compatible servers use `{ error: { message } }`, `{ error }`, or `{ message }`.
 */
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      const message = messageOf(body.detail) ?? messageOf(body.error) ?? messageOf(body.message);
      if (message) return message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.trim().slice(0, 300) || response.statusText;
}

async function send(options: EvaluateOptions<Record<string, Question>>): Promise<Response> {
  const { endpoint } = options;
  const doFetch = options.fetch ?? fetch;
  try {
    return await doFetch(endpointUrl(endpoint.baseUrl, endpoint.evaluatePath), {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: endpoint.model,
        state: options.state,
        questions: options.questions,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    const aborted = cause instanceof Error && /abort|timeout/i.test(cause.name);
    throw new System1Error(
      aborted ? "timeout" : "network",
      aborted
        ? "System 1 request timed out"
        : `Could not reach ${endpoint.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Evaluates `state` against `questions` in one request.
 *
 * @throws {System1Error} on a transport failure, a non-2xx status, or a
 * response whose answers do not match the questions asked.
 */
export async function evaluate<Q extends Record<string, Question>>(
  options: EvaluateOptions<Q>,
): Promise<EvaluateResult<Q>> {
  validateQuestions(options.questions);
  const response = await send(options);
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new System1Error(
      statusKind(response.status),
      `System 1 request failed (${response.status}): ${detail}`,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new System1Error("invalid-response", "System 1 response is not JSON");
  }
  return parseEvaluateResponse(options.questions, body);
}

/**
 * Verifies an endpoint and key with the cheapest possible request — one noul
 * question. Resolves with the model version that answered.
 */
export async function checkEndpoint(
  endpoint: System1Endpoint,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<string> {
  const result = await evaluate({
    endpoint,
    state: "Pragma is checking that this System 1 endpoint and API key work.",
    questions: { ok: { type: "noul", instructions: "Is this a connectivity check?" } },
    ...options,
  });
  return result.model;
}
