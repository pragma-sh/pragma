import type { evaluate } from "@pragma-sh/system1";
import { System1Error } from "@pragma-sh/system1";
import { describe, expect, it, vi } from "vitest";

import { MERGE_CONFLICTS } from "./constants.ts";
import {
  buildConflictQuestions,
  combinedScore,
  type ConflictFileInput,
  escalationReason,
  readSystem1Answers,
  resolveMergeConflicts,
  type ResolveConflictsRequest,
  RISK_LEVELS,
  type VerifyConflicts,
} from "./merge-conflicts.ts";
import { parseConflicts } from "./conflict-markers.ts";

const CONFLICTED = "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\nbottom\n";

function file(overrides: Partial<ConflictFileInput> = {}): ConflictFileInput {
  return {
    path: "src/a.ts",
    content: CONFLICTED,
    headCommits: ["abc123 feat: add ours"],
    baseCommits: ["def456 fix: change theirs"],
    ...overrides,
  };
}

function request(files: ConflictFileInput[]): ResolveConflictsRequest {
  return {
    endpoint: { baseUrl: "https://x", evaluatePath: "/v1/systemone", apiKey: "k", model: "jev" },
    pullRequest: { title: "Add ours", body: "Why", headRef: "feature", baseRef: "main" },
    files,
  };
}

/** A fake System 1 answering every conflict with one choice, confidence, and risk level. */
function fakeEvaluate(choice: string, confidence: number, riskLevel: number): typeof evaluate {
  return (async (options: { questions: Record<string, unknown> }) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(options.questions)) {
      answers[id] = id.endsWith("_risk")
        ? { type: "score", score: riskLevel, probabilities: {}, confidence: 1 }
        : { type: "choice", choice, probabilities: {}, confidence };
    }
    return { model: "jev", answers, usage: { inputTokens: 0, outputTokens: 0 } };
  }) as unknown as typeof evaluate;
}

const neverVerify: VerifyConflicts = () => {
  throw new Error("should not verify");
};

describe("buildConflictQuestions", () => {
  it("asks a choice and a risk score per conflict", () => {
    const { hunks } = parseConflicts(CONFLICTED);
    const questions = buildConflictQuestions("src/a.ts", hunks, request([]).pullRequest);
    expect(Object.keys(questions)).toEqual(["c1", "c1_risk"]);
    expect(questions.c1?.type).toBe("choice");
    expect(questions.c1_risk).toMatchObject({ type: "score", criteria: [...RISK_LEVELS] });
  });
});

/** A `combine` answer shaped like the API returns it. */
function answer(probabilities: Record<string, number>, confidence: number, risk: number) {
  return {
    c1: { choice: "combine", probabilities, confidence },
    c1_risk: { score: risk },
  };
}

describe("readSystem1Answers (answers replayed from a real Jev run)", () => {
  const { hunks } = parseConflicts(CONFLICTED);

  it("takes the best real option when a trivial conflict is marked combine", () => {
    // README.md: combine 0.73 but risk ~0 — two wordings of the same sentence.
    const picks = readSystem1Answers(
      hunks,
      answer(
        { combine: 0.73, ours: 0.14, theirs: 0.04, both_ours_first: 0.03, both_theirs_first: 0.06 },
        0.66,
        0.03,
      ),
    );
    expect(picks.get("c1")?.choice).toBe("ours");
    expect(picks.get("c1")?.confidence).toBeCloseTo(0.14 / 0.27);
    expect(escalationReason(hunks, picks)).toBeNull();
  });

  it("keeps combine, and escalates, when a wrong pick would do real damage", () => {
    // server.js: combine 0.99 at critical risk — PORT and the localhost bind both matter.
    const picks = readSystem1Answers(
      hunks,
      answer(
        { combine: 0.99, both_ours_first: 0.01, ours: 0, theirs: 0, both_theirs_first: 0 },
        0.98,
        3.94,
      ),
    );
    expect(picks.get("c1")?.choice).toBe("combine");
    expect(escalationReason(hunks, picks)).toMatch(/hand merge/);
  });
});

describe("combinedScore", () => {
  it("discounts confidence by weighted risk", () => {
    expect(combinedScore(0.9, 0)).toBeCloseTo(0.9);
    expect(combinedScore(0.9, 1)).toBeCloseTo(0.9 * (1 - MERGE_CONFLICTS.riskWeight));
  });
});

describe("resolveMergeConflicts", () => {
  it("keeps a confident, low-risk System 1 answer without verifying", async () => {
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: fakeEvaluate("theirs", 0.95, 0),
      verify: neverVerify,
    });
    expect(outcome).toMatchObject({
      status: "resolved",
      method: "system1",
      content: "top\ntheirs\nbottom\n",
    });
  });

  it("verifies a file whose combined score is below the bar, with System 1's context", async () => {
    const verify = vi.fn<VerifyConflicts>(async () => [
      { id: "c1", resolution: "custom", content: "merged", reason: "both matter" },
    ]);
    const progress = vi.fn();
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: fakeEvaluate("ours", 0.3, 4),
      verify,
      onProgress: progress,
    });
    expect(outcome).toMatchObject({
      status: "resolved",
      method: "verified",
      content: "top\nmerged\nbottom\n",
    });
    const context = verify.mock.calls[0]?.[0];
    expect(context?.baseCommits).toEqual(["def456 fix: change theirs"]);
    expect(context?.pullRequestBody).toBe("Why");
    expect(context?.hunks[0]?.system1).toMatchObject({ choice: "ours", risk: 1 });
    expect(progress).toHaveBeenCalledWith({ phase: "verifying", path: "src/a.ts" });
  });

  it("trusts a moderately confident pick even on a critical-risk conflict", async () => {
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: fakeEvaluate("both_ours_first", 0.55, 4),
      verify: neverVerify,
    });
    expect(outcome).toMatchObject({ status: "resolved", method: "system1" });
  });

  it("verifies whenever System 1 says the sides must be combined, however confident", async () => {
    const verify = vi.fn<VerifyConflicts>(async () => [
      { id: "c1", resolution: "custom", content: "ours and theirs", reason: "merged" },
    ]);
    const log = vi.fn();
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: fakeEvaluate("combine", 0.95, 3),
      verify,
      log,
    });
    expect(outcome).toMatchObject({ status: "resolved", method: "verified" });
    expect(verify.mock.calls[0]?.[0].escalation).toMatch(/hand merge/);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/a.ts",
        model: "jev",
        answers: expect.objectContaining({ c1: expect.objectContaining({ choice: "combine" }) }),
      }),
    );
  });

  it("escalates when System 1 fails, and reports a verifier failure per file", async () => {
    const failing = (async () => {
      throw new System1Error("rate-limit", "slow down", 429);
    }) as unknown as typeof evaluate;
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: failing,
      verify: async () => {
        throw new Error("no model");
      },
    });
    expect(outcome).toEqual({ path: "src/a.ts", status: "failed", reason: "no model" });
  });

  it("rejects a verifier answer that leaves conflict markers", async () => {
    const [outcome] = await resolveMergeConflicts(request([file()]), {
      evaluate: fakeEvaluate("ours", 0.1, 4),
      verify: async () => [
        { id: "c1", resolution: "custom", content: "<<<<<<< HEAD\nx\n", reason: "" },
      ],
    });
    expect(outcome?.status).toBe("failed");
  });

  it("skips binary files and marker-free conflicts", async () => {
    const outcomes = await resolveMergeConflicts(
      request([file({ path: "logo.png", content: null }), file({ content: "no markers\n" })]),
      { evaluate: fakeEvaluate("ours", 1, 0), verify: neverVerify },
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
  });

  it("sends every file's System 1 request before any finishes", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = (async (options: Parameters<typeof evaluate>[0]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fakeEvaluate("ours", 1, 0)(options);
    }) as unknown as typeof evaluate;
    await resolveMergeConflicts(request([file(), file({ path: "b" }), file({ path: "c" })]), {
      evaluate: slow,
      verify: neverVerify,
    });
    expect(peak).toBe(3);
  });
});
