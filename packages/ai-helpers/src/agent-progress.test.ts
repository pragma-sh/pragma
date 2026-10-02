import { describe, expect, it, vi } from "vitest";

import {
  AgentProgressError,
  type AgentProgressRequest,
  estimateAgentProgress,
  parseAgentProgressRequest,
} from "./agent-progress.ts";

const ACTIVITIES = [
  { id: "exploring", label: "Exploring", description: "Reading code." },
  { id: "coding", label: "Coding", description: "Editing files." },
  { id: "verifying", label: "Verifying", description: "Running checks." },
];

const LEVELS = ["not started", "half", "complete"];

function request(overrides: Partial<AgentProgressRequest> = {}): AgentProgressRequest {
  return {
    endpoint: {
      baseUrl: "https://jev.example",
      evaluatePath: "/v1/systemone",
      apiKey: "key",
      model: "jev-latest",
    },
    agent: "Claude Code",
    status: "running",
    prompt: "Add a progress bar to the sidebar",
    lastMessage: "I've updated the sidebar component and am now running the tests.",
    activities: ACTIVITIES,
    progressLevels: LEVELS,
    limits: { promptChars: 6000, messageChars: 20, timeoutMs: 5000 },
    ...overrides,
  };
}

/** A fetch double that records the request body and answers with `answers`. */
function jev(answers: Record<string, unknown>) {
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }));
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

const answers = (score: number, choice: string) => ({
  progress: { type: "score", score, probabilities: {}, confidence: 0.9 },
  activity: { type: "choice", choice, probabilities: { [choice]: 0.7 }, confidence: 0.7 },
});

describe("estimateAgentProgress", () => {
  it("normalises the progress score and returns the chosen activity", async () => {
    const double = jev(answers(1.5, "verifying"));
    const result = await estimateAgentProgress(request(), { fetch: double.fetch });
    expect(result).toEqual({ progress: 0.75, activity: "verifying", confidence: 0.7 });
    expect(double.fetch).toHaveBeenCalledTimes(1);
  });

  it("asks both questions in one request with the configured options", async () => {
    const double = jev(answers(0, "exploring"));
    await estimateAgentProgress(request(), { fetch: double.fetch });
    const [call] = double.calls;
    expect(call?.questions.progress).toMatchObject({ type: "score", criteria: LEVELS });
    expect(call?.questions.activity).toMatchObject({
      type: "choice",
      criteria: {
        exploring: "Reading code.",
        coding: "Editing files.",
        verifying: "Running checks.",
      },
    });
  });

  it("keeps the tail of a long agent reply and omits an absent follow-up", async () => {
    const double = jev(answers(0, "coding"));
    await estimateAgentProgress(request(), { fetch: double.fetch });
    const state = double.calls[0]?.state;
    expect(state?.latest_agent_message).toBe("(truncated)…\nw running the tests.");
    expect(state).not.toHaveProperty("follow_up");
    expect(state?.task).toBe("Add a progress bar to the sidebar");
  });

  it("falls back to the first activity when the model answers an unknown id", async () => {
    const double = jev(answers(2, "dancing"));
    const result = await estimateAgentProgress(request(), { fetch: double.fetch });
    expect(result.activity).toBe("exploring");
    expect(result.progress).toBe(1);
  });
});

describe("parseAgentProgressRequest", () => {
  it("rejects a request without an endpoint key", () => {
    expect(() => parseAgentProgressRequest(JSON.stringify({ limits: {} }))).toThrow(
      AgentProgressError,
    );
  });

  it("rejects a request with too few options", () => {
    const raw = JSON.stringify({ ...request(), activities: [ACTIVITIES[0]] });
    expect(() => parseAgentProgressRequest(raw)).toThrow(AgentProgressError);
  });

  it("defaults optional text fields", () => {
    const { prompt: _prompt, lastMessage: _last, ...rest } = request();
    const parsed = parseAgentProgressRequest(JSON.stringify(rest));
    expect(parsed.prompt).toBe("");
    expect(parsed.lastMessage).toBe("");
  });
});
