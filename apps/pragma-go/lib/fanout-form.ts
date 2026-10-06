import {
  constants,
  type FanoutCreateRequest,
  type FanoutDeliveryReceipt,
  type FanoutPickResult,
  type FanoutSendTarget,
} from "@pragma-sh/constants";
import { PragmaGatewayError } from "@pragma-sh/sdk";

import type { AgentModelSelection } from "./data/agents";

// Pure, RN-free fanout form model, beside `launch-form.ts`: the launch sheet
// holds the attempt rows and turns them into a `FanoutCreateRequest`. Kept free
// of React so the validation is unit tested rather than clicked through.

/** One attempt row. `key` is stable across edits so rows never remount. */
export interface FanoutAttempt {
  key: string;
  selection: AgentModelSelection | null;
}

/** The fanout fields the sheet collects on top of the shared prompt. */
export interface FanoutFormState {
  prompt: string;
  /** Branch of the coordination parent the attempts hang off. */
  branch: string;
  title: string;
  attempts: FanoutAttempt[];
}

/** Context supplied by the worktree the sheet was opened from. */
export interface FanoutContext {
  projectId: string;
  /** The worktree the fresh coordination parent is branched from. */
  worktreeId: string;
}

/** Fewest attempts a fanout may have; one attempt is an ordinary launch. */
export const MIN_FANOUT_ATTEMPTS: number = constants.fanout.minMembers;

let nextKey = 0;

/** A new attempt row, optionally seeded with a selection. */
export function newAttempt(selection: AgentModelSelection | null): FanoutAttempt {
  nextKey += 1;
  return { key: `attempt-${nextKey}`, selection };
}

/**
 * The rows a fanout starts with: the current single-agent selection, repeated
 * up to the member floor. Sampling one model twice is a supported fanout, so a
 * duplicate is a sensible default rather than a placeholder to fix.
 */
export function initialAttempts(selection: AgentModelSelection | null): FanoutAttempt[] {
  return Array.from({ length: MIN_FANOUT_ATTEMPTS }, () => newAttempt(selection));
}

export type FanoutBuildResult =
  | { ok: true; request: FanoutCreateRequest }
  | { ok: false; reason: string };

/**
 * Validates the form and shapes the create request.
 *
 * Like the desktop, a fanout always branches its own coordination parent from
 * the worktree the sheet was opened on: attempts never land under a worktree
 * the user is already working in, and the host refuses a dirty existing parent.
 */
export function buildFanoutRequest(
  state: FanoutFormState,
  context: FanoutContext,
): FanoutBuildResult {
  const prompt = state.prompt.trim();
  if (!prompt) return { ok: false, reason: "Write the prompt every attempt will run." };
  const branch = state.branch.trim();
  if (!branch) return { ok: false, reason: "Enter a branch name for the fanout." };
  const chosen = state.attempts.flatMap((attempt) =>
    attempt.selection ? [attempt.selection] : [],
  );
  if (chosen.length < state.attempts.length) {
    return { ok: false, reason: "Choose an agent for every attempt." };
  }
  if (chosen.length < MIN_FANOUT_ATTEMPTS) {
    return { ok: false, reason: `A fanout needs at least ${MIN_FANOUT_ATTEMPTS} attempts.` };
  }
  return {
    ok: true,
    request: {
      projectId: context.projectId,
      parent: {
        kind: "new",
        sourceWorktreeId: context.worktreeId,
        branch,
        title: state.title.trim() || null,
      },
      prompt,
      defaultReasoningId: null,
      members: chosen.map((selection) => ({
        selector: selection.agentId,
        modelId: selection.modelId || null,
        reasoningId: selection.reasoningId,
      })),
    },
  };
}

/**
 * The reason a fanout action failed, in the host's own words.
 *
 * The gateway carries the host's `FanoutFailure` in `details`, and its message
 * already says what to do ("this fanout is finalizing; wait…", "parent has
 * uncommitted changes"). Only an error without one falls back to `fallback`.
 */
export function fanoutFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof PragmaGatewayError) {
    const details = error.details as { message?: unknown } | undefined;
    if (typeof details?.message === "string" && details.message.trim()) return details.message;
    if (error.message.trim()) return error.message;
  }
  return fallback;
}

/** Who a follow-up goes to: the attempt in view when asked for and known, else every attempt. */
export function followUpTarget(
  scope: "all" | "member",
  currentMemberId: string | undefined,
): FanoutSendTarget {
  return scope === "member" && currentMemberId
    ? { kind: "member", memberId: currentMemberId }
    : { kind: "all" };
}

/** One line on how a follow-up landed. */
export function followUpSummary({
  delivered,
  failed,
}: {
  delivered: number;
  failed: number;
}): string {
  if (failed > 0) return `Sent to ${delivered}; ${failed} did not take it.`;
  return `Sent to ${delivered} attempt${delivered === 1 ? "" : "s"}.`;
}

/** Delivered vs. not, across a send's per-attempt receipts. */
export function summarizeReceipts(receipts: readonly FanoutDeliveryReceipt[]): {
  delivered: number;
  failed: number;
} {
  const failed = receipts.filter(
    (receipt) => receipt.state === "failed" || receipt.state === "timedOut",
  ).length;
  return { delivered: receipts.length - failed, failed };
}

/** True when a pick merged the winner and removed every attempt worktree. */
export function isCleanPick(result: FanoutPickResult): boolean {
  return result.stage === "completed" && result.survivingWorktreeIds.length === 0;
}

/**
 * What to tell the user after a pick that stopped short. A pick resolves even
 * when it halted, with the stage to resume from; picking again resumes it.
 */
export function pickNotice(result: FanoutPickResult): { title: string; message: string } | null {
  if (result.fanout.status === "needsResolution") {
    return {
      title: "Merge conflict",
      message:
        "The picked attempt conflicts with the fanout branch. Resolve it on your computer, then pick again to finish.",
    };
  }
  const surviving = result.survivingWorktreeIds.length;
  if (surviving > 0) {
    return {
      title: "Merged, but cleanup was incomplete",
      message: `${surviving} attempt worktree(s) could not be removed. Pick again to retry the cleanup.`,
    };
  }
  const failure = result.failures[0];
  return failure ? { title: "Pick stopped", message: failure.message } : null;
}
