/**
 * AI merge-conflict resolution: System 1 first, the built-in AI when System 1
 * is not sure enough.
 *
 * Every conflicted file is one System 1 request, and all files are sent at
 * once. Each conflict in a file is asked as two questions evaluated in
 * parallel within that request:
 *
 * - `<id>` — a choice between the four standard resolutions, phrased as "what
 *   would an experienced engineer on this project pick". Its calibrated
 *   `confidence` is therefore the probability a human would pick the same.
 * - `<id>_risk` — a score for how much damage a wrong resolution would do.
 *
 * `confidence × (1 − riskWeight × risk)` is the conflict's combined score. If
 * any conflict in a file falls below {@link MERGE_CONFLICTS.minCombinedScore},
 * or System 1 could not see or answer the file, the whole file is handed to a
 * high-tier model with the same context plus System 1's answers.
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
  applyResolutions,
  CONFLICT_CHOICES,
  type ConflictChoice,
  type ConflictHunk,
  type ConflictResolution,
  hasConflictMarkers,
  hunkContext,
  MalformedConflictError,
  parseConflicts,
  type ParsedConflictFile,
} from "./conflict-markers.ts";
import { MERGE_CONFLICTS } from "./constants.ts";
import type { ConflictVerificationAnswer, ConflictVerificationPromptContext } from "./prompts.ts";

/** The pull request whose branch is being merged, as intent for both models. */
export interface ConflictPullRequest {
  title: string;
  body: string;
  /** The pull request branch — "ours". */
  headRef: string;
  /** The base branch merged into it — "theirs". */
  baseRef: string;
}

/** One conflicted file. `content` is `null` when it is binary or missing on disk. */
export interface ConflictFileInput {
  path: string;
  content: string | null;
  /** `<sha> <subject>` for pull-request-branch commits touching the file, newest first. */
  headCommits: string[];
  /** `<sha> <subject>` for base-branch commits touching the file, newest first. */
  baseCommits: string[];
}

/** What the `resolve-conflicts` sidecar command reads on stdin. */
export interface ResolveConflictsRequest {
  endpoint: System1Endpoint;
  pullRequest: ConflictPullRequest;
  files: ConflictFileInput[];
}

/** System 1's answer for one conflict. */
export interface System1HunkAnswer {
  /** `combine` means no pick is correct: the sides must be merged by hand. */
  choice: ConflictChoice | "combine";
  /** Probability a careful engineer would pick the same resolution, 0–1. */
  confidence: number;
  /** How damaging a wrong resolution would be, 0 (harmless) – 1 (critical). */
  risk: number;
  /** `confidence × (1 − riskWeight × risk)`. */
  combined: number;
}

/** How one conflict ended up resolved. */
export interface HunkDecision {
  id: string;
  startLine: number;
  resolution: ConflictChoice | "custom";
  source: "system1" | "verified";
  system1: System1HunkAnswer | null;
  /** The verifier's explanation, when it looked at this conflict. */
  reason: string | null;
}

/** The outcome for one file. */
export type ConflictFileOutcome =
  | {
      path: string;
      status: "resolved";
      method: "system1" | "verified";
      /** Why the file was verified, when it was. */
      escalation: string | null;
      content: string;
      hunks: HunkDecision[];
    }
  | { path: string; status: "skipped" | "failed"; reason: string };

/** Progress the UI shows on the button. */
export type ResolveConflictsProgress =
  | { phase: "system1"; files: number }
  | { phase: "verifying"; path: string };

/** Everything the verifier needs; the injected `verify` returns one answer per conflict. */
export type VerifyConflicts = (
  context: ConflictVerificationPromptContext,
) => Promise<ConflictVerificationAnswer[]>;

/** Seams for tests. */
export interface ResolveConflictsDeps {
  verify: VerifyConflicts;
  evaluate?: typeof evaluate;
  onProgress?: (event: ResolveConflictsProgress) => void;
  /** Receives each file's raw System 1 answers and the decision drawn from them. */
  log?: (entry: Record<string, unknown>) => void;
}

/** Wrong-resolution severity, lowest first; the score's index is the risk. */
export const RISK_LEVELS = [
  "Trivial: whitespace, formatting, comments, or docs — a wrong pick is harmless.",
  "Low: isolated, easily noticed change such as a log line, a label, or a test fixture.",
  "Moderate: changes behavior in a contained way; tests or review would likely catch it.",
  "High: core logic, data handling, or an API; a wrong pick likely ships a bug.",
  "Critical: security, persistence, migrations, or a public contract; a wrong pick causes real damage.",
] as const;

function truncate(text: string, limit: number): { text: string; cut: boolean } {
  return text.length > limit
    ? { text: `${text.slice(0, limit)}\n[... truncated ...]`, cut: true }
    : { text, cut: false };
}

/** The System 1 `state` for one file, and whether any conflict side had to be cut. */
export function buildConflictState(
  input: ConflictFileInput,
  parsed: ParsedConflictFile,
  pullRequest: ConflictPullRequest,
): { state: Structured; truncated: boolean } {
  let truncated = false;
  const side = (text: string) => {
    const result = truncate(text, MERGE_CONFLICTS.maxSideChars);
    truncated ||= result.cut;
    return result.text;
  };
  const conflicts = parsed.hunks.map((hunk) => {
    const { before, after } = hunkContext(parsed, hunk, MERGE_CONFLICTS.contextLines);
    return {
      id: hunk.id,
      line: hunk.startLine,
      before: side(before),
      ours: side(hunk.ours),
      ...(hunk.base === null ? {} : { mergeBase: side(hunk.base) }),
      theirs: side(hunk.theirs),
      after: side(after),
    };
  });
  const state = {
    task:
      "Resolve git merge conflicts in one file. The base branch was merged into the pull " +
      'request branch. "ours" is the pull request branch; "theirs" is the base branch.',
    file: input.path,
    pullRequest: {
      title: pullRequest.title,
      description: truncate(pullRequest.body, MERGE_CONFLICTS.maxDescriptionChars).text,
      branch: pullRequest.headRef,
      baseBranch: pullRequest.baseRef,
    },
    commitsTouchingThisFile: {
      pullRequestBranch: input.headCommits.slice(0, MERGE_CONFLICTS.maxCommitsPerSide),
      baseBranch: input.baseCommits.slice(0, MERGE_CONFLICTS.maxCommitsPerSide),
    },
    conflicts,
  };
  return { state, truncated };
}

/** The two questions asked for every conflict. */
export function buildConflictQuestions(
  path: string,
  hunks: readonly ConflictHunk[],
  pullRequest: ConflictPullRequest,
): Record<string, Question> {
  const head = `the pull request branch (${pullRequest.headRef})`;
  const base = `the base branch (${pullRequest.baseRef})`;
  const questions: Record<string, Question> = {};
  for (const hunk of hunks) {
    const where = `Conflict ${hunk.id} (line ${hunk.startLine}) in ${path}`;
    const choice: ChoiceQuestion = {
      type: "choice",
      instructions:
        `${where}: which resolution would an experienced engineer on this project choose, ` +
        "given what each branch was trying to do (commit messages and pull request description)? " +
        "Prefer the simplest resolution a reviewer would accept. When one side's change is " +
        "cosmetic (wording, formatting, comments, naming) or already covered by the other side, " +
        "pick a side rather than combining.",
      criteria: {
        ours: `Keep only ${head}'s side; drop ${base}'s side.`,
        theirs: `Keep only ${base}'s side; drop ${head}'s side.`,
        both_ours_first: `Keep both sides: ${head}'s side first, then ${base}'s.`,
        both_theirs_first: `Keep both sides: ${base}'s side first, then ${head}'s.`,
        combine:
          "Only when every option above is wrong: picking a side would lose a change that " +
          "matters (a bug fix, a feature, a security or behavior change), and keeping both " +
          "would duplicate or break code, so the edits must be merged by hand into new text. " +
          "Never for differences in wording, formatting, or comments where either side is fine.",
      },
    };
    const risk: ScoreQuestion = {
      type: "score",
      instructions: `${where}: if this conflict were resolved the wrong way, how much damage would it do?`,
      criteria: [...RISK_LEVELS],
    };
    questions[hunk.id] = choice;
    questions[`${hunk.id}_risk`] = risk;
  }
  return questions;
}

/** Combines confidence and risk into the score compared against the threshold. */
export function combinedScore(confidence: number, risk: number): number {
  return confidence * (1 - MERGE_CONFLICTS.riskWeight * risk);
}

function isChoice(value: string): value is ConflictChoice {
  return (CONFLICT_CHOICES as readonly string[]).includes(value);
}

/** One raw System 1 answer, as much of it as {@link readSystem1Answers} reads. */
type RawAnswer = {
  choice?: string;
  confidence?: number;
  score?: number;
  probabilities?: Record<string, number>;
};

/**
 * The best real option when System 1 asked for a hand merge on a conflict too
 * trivial to be worth one: the most likely pick, with its probability
 * renormalized over the four real options (i.e. "given it isn't a hand merge").
 */
function bestRealChoice(
  probabilities: Record<string, number> | undefined,
): { choice: ConflictChoice; confidence: number } | null {
  const ranked = CONFLICT_CHOICES.map((choice) => ({
    choice,
    probability: probabilities?.[choice] ?? 0,
  })).toSorted((a, b) => b.probability - a.probability);
  const total = ranked.reduce((sum, entry) => sum + entry.probability, 0);
  const best = ranked[0];
  return best && total > 0 ? { choice: best.choice, confidence: best.probability / total } : null;
}

/** One conflict's pick, demoting a `combine` on a trivial conflict to a real option. */
function readPick(choice: ConflictChoice | "combine", answer: RawAnswer, risk: number) {
  const confidence = answer.confidence ?? 0;
  if (choice !== "combine" || risk >= MERGE_CONFLICTS.combineMinRisk) {
    return { choice, confidence };
  }
  return bestRealChoice(answer.probabilities) ?? { choice, confidence };
}

/** Reads System 1's answers into per-conflict picks. */
export function readSystem1Answers(
  hunks: readonly ConflictHunk[],
  answers: Record<string, RawAnswer>,
): Map<string, System1HunkAnswer> {
  const picks = new Map<string, System1HunkAnswer>();
  for (const hunk of hunks) {
    const answer = answers[hunk.id] ?? {};
    const raw = answer.choice ?? "";
    if (!isChoice(raw) && raw !== "combine") continue;
    const riskScore = answers[`${hunk.id}_risk`]?.score ?? RISK_LEVELS.length - 1;
    const risk = Math.min(1, Math.max(0, riskScore / (RISK_LEVELS.length - 1)));
    const { choice, confidence } = readPick(raw, answer, risk);
    picks.set(hunk.id, { choice, confidence, risk, combined: combinedScore(confidence, risk) });
  }
  return picks;
}

/** Why a file cannot be trusted to System 1 alone, or `null` when it can. */
export function escalationReason(
  hunks: readonly ConflictHunk[],
  picks: ReadonlyMap<string, System1HunkAnswer>,
): string | null {
  const weak = hunks.flatMap((hunk) => {
    const pick = picks.get(hunk.id);
    if (!pick) return [`${hunk.id} was not answered`];
    if (pick.choice === "combine") {
      return [`${hunk.id} needs a hand merge (System 1 confidence ${pick.confidence.toFixed(2)})`];
    }
    return pick.combined < MERGE_CONFLICTS.minCombinedScore
      ? [
          `${hunk.id} scored ${pick.combined.toFixed(2)} ` +
            `(confidence ${pick.confidence.toFixed(2)}, risk ${pick.risk.toFixed(2)})`,
        ]
      : [];
  });
  if (weak.length === 0) return null;
  return `Not safe to take System 1's pick alone: ${weak.join("; ")}.`;
}

/** Converts one verifier answer into a resolution, rejecting anything unusable. */
function verifiedResolution(answer: ConflictVerificationAnswer): ConflictResolution {
  if (isChoice(answer.resolution)) return { kind: answer.resolution };
  if (answer.resolution === "custom" && typeof answer.content === "string") {
    if (hasConflictMarkers(answer.content)) {
      throw new Error(`verifier left conflict markers in ${answer.id}`);
    }
    return { kind: "custom", content: answer.content };
  }
  throw new Error(`verifier returned an unusable resolution for ${answer.id}`);
}

async function askSystem1(
  input: ConflictFileInput,
  parsed: ParsedConflictFile,
  request: ResolveConflictsRequest,
  deps: ResolveConflictsDeps,
): Promise<{ picks: Map<string, System1HunkAnswer>; escalation: string | null }> {
  const run = deps.evaluate ?? evaluate;
  const { state, truncated } = buildConflictState(input, parsed, request.pullRequest);
  try {
    const result = await run({
      endpoint: request.endpoint,
      state,
      questions: buildConflictQuestions(input.path, parsed.hunks, request.pullRequest),
      signal: AbortSignal.timeout(MERGE_CONFLICTS.system1TimeoutMs),
    });
    const picks = readSystem1Answers(parsed.hunks, result.answers as Record<string, RawAnswer>);
    const escalation = truncated
      ? "Part of a conflict was too large for System 1 to see in full."
      : escalationReason(parsed.hunks, picks);
    deps.log?.({
      path: input.path,
      model: result.model,
      answers: result.answers,
      scores: Object.fromEntries(picks),
      escalation,
    });
    return { picks, escalation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.({ path: input.path, error: message });
    return { picks: new Map(), escalation: `System 1 could not answer: ${message}` };
  }
}

async function verifyFile(
  input: ConflictFileInput & { content: string },
  parsed: ParsedConflictFile,
  request: ResolveConflictsRequest,
  picks: ReadonlyMap<string, System1HunkAnswer>,
  escalation: string,
  verify: VerifyConflicts,
): Promise<Map<string, { resolution: ConflictResolution; reason: string }>> {
  const answers = await verify({
    path: input.path,
    content: input.content,
    headRef: request.pullRequest.headRef,
    baseRef: request.pullRequest.baseRef,
    pullRequestTitle: request.pullRequest.title,
    pullRequestBody: request.pullRequest.body,
    headCommits: input.headCommits.slice(0, MERGE_CONFLICTS.maxCommitsPerSide),
    baseCommits: input.baseCommits.slice(0, MERGE_CONFLICTS.maxCommitsPerSide),
    escalation,
    hunks: parsed.hunks.map((hunk) => ({
      id: hunk.id,
      startLine: hunk.startLine,
      ours: hunk.ours,
      base: hunk.base,
      theirs: hunk.theirs,
      system1: picks.get(hunk.id) ?? null,
    })),
  });
  return new Map(
    answers.map((answer) => [
      answer.id,
      { resolution: verifiedResolution(answer), reason: answer.reason },
    ]),
  );
}

type VerifiedHunks = Map<string, { resolution: ConflictResolution; reason: string }>;

/** Parses a file, or explains why it is left for a human. */
function prepareFile(
  input: ConflictFileInput,
): { parsed: ParsedConflictFile; content: string } | ConflictFileOutcome {
  const { path, content } = input;
  if (content === null) {
    return { path, status: "skipped", reason: "Binary, deleted, or unreadable — resolve by hand." };
  }
  try {
    const parsed = parseConflicts(content);
    if (parsed.hunks.length > 0) return { parsed, content };
    return {
      path,
      status: "skipped",
      reason: "No conflict markers (e.g. a rename or delete conflict) — resolve by hand.",
    };
  } catch (error) {
    if (!(error instanceof MalformedConflictError)) throw error;
    return { path, status: "skipped", reason: `Unreadable conflict markers: ${error.message}` };
  }
}

/** The final resolution per conflict: the verifier's word over System 1's. */
function decideHunks(
  parsed: ParsedConflictFile,
  picks: ReadonlyMap<string, System1HunkAnswer>,
  verified: VerifiedHunks,
): { resolutions: Map<string, ConflictResolution>; hunks: HunkDecision[] } {
  const resolutions = new Map<string, ConflictResolution>();
  const hunks = parsed.hunks.map((hunk): HunkDecision => {
    const check = verified.get(hunk.id);
    const pick = picks.get(hunk.id) ?? null;
    // A missing pick always escalates, so the "ours" fallback is unreachable
    // in practice; it only keeps the type total.
    const fallback = pick && pick.choice !== "combine" ? pick.choice : "ours";
    const resolution = check?.resolution ?? { kind: fallback };
    resolutions.set(hunk.id, resolution);
    return {
      id: hunk.id,
      startLine: hunk.startLine,
      resolution: resolution.kind,
      source: check ? "verified" : "system1",
      system1: pick,
      reason: check?.reason || null,
    };
  });
  return { resolutions, hunks };
}

/** Asks System 1, verifies when it is not trusted, and builds the resolved file. */
async function decideFile(
  input: ConflictFileInput,
  prepared: { parsed: ParsedConflictFile; content: string },
  request: ResolveConflictsRequest,
  deps: ResolveConflictsDeps,
): Promise<ConflictFileOutcome> {
  const { parsed, content } = prepared;
  const { picks, escalation } = await askSystem1(input, parsed, request, deps);
  let verified: VerifiedHunks = new Map();
  if (escalation !== null) {
    deps.onProgress?.({ phase: "verifying", path: input.path });
    const file = { ...input, content };
    verified = await verifyFile(file, parsed, request, picks, escalation, deps.verify);
  }
  const { resolutions, hunks } = decideHunks(parsed, picks, verified);
  const resolved = applyResolutions(parsed, resolutions);
  if (hasConflictMarkers(resolved)) {
    return {
      path: input.path,
      status: "failed",
      reason: "The resolution still contains conflict markers.",
    };
  }
  return {
    path: input.path,
    status: "resolved",
    method: escalation === null ? "system1" : "verified",
    escalation,
    content: resolved,
    hunks,
  };
}

/** Resolves one file end to end. Never throws: failures become a `failed` outcome. */
async function resolveFile(
  input: ConflictFileInput,
  request: ResolveConflictsRequest,
  deps: ResolveConflictsDeps,
): Promise<ConflictFileOutcome> {
  try {
    const prepared = prepareFile(input);
    if ("status" in prepared) return prepared;
    return await decideFile(input, prepared, request, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { path: input.path, status: "failed", reason };
  }
}

/**
 * Resolves every conflicted file, all System 1 requests in flight at once. A
 * file that fails is reported, never fatal to the others.
 */
export async function resolveMergeConflicts(
  request: ResolveConflictsRequest,
  deps: ResolveConflictsDeps,
): Promise<ConflictFileOutcome[]> {
  deps.onProgress?.({ phase: "system1", files: request.files.length });
  return Promise.all(request.files.map((file) => resolveFile(file, request, deps)));
}

/** Parses the sidecar's stdin JSON, filling defaults for optional fields. */
export function parseResolveConflictsRequest(raw: string): ResolveConflictsRequest {
  const body = JSON.parse(raw) as Partial<ResolveConflictsRequest>;
  if (!body.endpoint) throw new Error("resolve-conflicts needs a System 1 endpoint");
  const pr: Partial<ConflictPullRequest> = body.pullRequest ?? {};
  return {
    endpoint: body.endpoint,
    pullRequest: {
      title: pr.title ?? "",
      body: pr.body ?? "",
      headRef: pr.headRef ?? "HEAD",
      baseRef: pr.baseRef ?? "base",
    },
    files: (Array.isArray(body.files) ? body.files : []).map((file) => ({
      path: file.path,
      content: typeof file.content === "string" ? file.content : null,
      headCommits: Array.isArray(file.headCommits) ? file.headCommits : [],
      baseCommits: Array.isArray(file.baseCommits) ? file.baseCommits : [],
    })),
  };
}
