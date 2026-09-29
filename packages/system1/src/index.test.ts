import { describe, expect, it, vi } from "vitest";

import {
  checkEndpoint,
  endpointUrl,
  evaluate,
  parseEvaluateResponse,
  System1Error,
  type System1Endpoint,
} from "./index.ts";

const endpoint: System1Endpoint = {
  baseUrl: "https://api.example.test/",
  evaluatePath: "/v1/systemone",
  apiKey: "secret",
  model: "jev-latest",
};

const unreachable = async () => {
  throw new TypeError("fetch failed");
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("endpointUrl", () => {
  it("joins with exactly one slash", () => {
    expect(endpointUrl("https://a.test/", "/v1/x")).toBe("https://a.test/v1/x");
    expect(endpointUrl("https://a.test", "v1/x")).toBe("https://a.test/v1/x");
    expect(endpointUrl(" https://a.test// ", "//v1/x")).toBe("https://a.test/v1/x");
  });

  it("uses a full endpoint URL as-is", () => {
    expect(endpointUrl("https://openrouter.ai/api/alpha/decisions", "/v1/systemone")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
    expect(endpointUrl("https://api.typesafe.ai/v1/systemone/", "/v1/systemone")).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
  });
});

describe("evaluate", () => {
  it("sends the model, state, and questions with a bearer token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          team: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.9, technical: 0.1 },
            confidence: 0.8,
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
    const result = await evaluate({
      endpoint,
      state: "payouts failing",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "money", technical: null },
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.answers.team.choice).toBe("billing");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/systemone");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "jev-latest",
      state: "payouts failing",
    });
  });

  it("classifies HTTP failures", async () => {
    const fetchMock = async () => jsonResponse({ error: { message: "bad key" } }, 401);
    await expect(
      evaluate({
        endpoint,
        state: "x",
        questions: { q: { type: "noul", instructions: "?" } },
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      message: expect.stringContaining("bad key"),
    });
  });

  it("reads TypeSafe's nested error detail", async () => {
    const fetchMock = async () =>
      jsonResponse(
        { detail: { error_type: "authentication_error", message: "Check your key." } },
        401,
      );
    await expect(
      evaluate({
        endpoint,
        state: "x",
        questions: { q: { type: "noul", instructions: "?" } },
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("System 1 request failed (401): Check your key.");
  });

  it("reports network failures without an HTTP status", async () => {
    const error = await evaluate({
      endpoint,
      state: "x",
      questions: { q: { type: "noul", instructions: "?" } },
      fetch: unreachable as unknown as typeof fetch,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(System1Error);
    expect(error).toMatchObject({ kind: "network", status: null });
  });

  it("rejects an out-of-range option set before sending", async () => {
    const fetchMock = vi.fn();
    await expect(
      evaluate({
        endpoint,
        state: "x",
        questions: { q: { type: "score", instructions: "?", criteria: ["only"] } },
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "bad-request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseEvaluateResponse", () => {
  it("rejects an answer of the wrong type", () => {
    expect(() =>
      parseEvaluateResponse(
        { q: { type: "noul", instructions: "?" } },
        { answers: { q: { type: "choice", choice: "a", probabilities: {}, confidence: 1 } } },
      ),
    ).toThrow(/malformed/);
  });

  it("parses score answers", () => {
    const result = parseEvaluateResponse(
      { level: { type: "score", instructions: "?", criteria: ["low", "high"] } },
      {
        model: "jev",
        answers: {
          level: {
            type: "score",
            score: 0.7,
            probabilities: { "0": 0.3, "1": 0.7 },
            confidence: 0.5,
          },
        },
      },
    );
    expect(result.answers.level.score).toBe(0.7);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("checkEndpoint", () => {
  it("resolves with the answering model version", async () => {
    const fetchMock = async () =>
      jsonResponse({ model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 } } });
    await expect(
      checkEndpoint(endpoint, { fetch: fetchMock as unknown as typeof fetch }),
    ).resolves.toBe("jev-1.13.0");
  });
});
