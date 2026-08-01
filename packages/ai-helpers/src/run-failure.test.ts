import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { classifyFailure, describeFailure, NoWorkingModelError } from "./run-failure.ts";

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}

describe("classifyFailure", () => {
  it.each([
    ['401 {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}'],
    ["OpenAI API error (429): 429 quota exceeded"],
    ['Codex error: {"type":"usage_limit_reached","message":"The usage limit has been reached"}'],
    ["402 Payment required"],
    ["403 Forbidden"],
    ["Insufficient credits on this account"],
  ])("retires the whole provider for %s", (message) => {
    expect(classifyFailure(new Error(message))).toBe("provider");
  });

  it.each([
    ["400 The model `x` is not available"],
    ["Request exceeds the model's context window"],
    ["The model returned no text."],
  ])("blames only the model for %s", (message) => {
    expect(classifyFailure(new Error(message))).toBe("model");
  });

  it("classifies non-Error throws", () => {
    expect(classifyFailure("401 Invalid API key.")).toBe("provider");
  });
});

describe("describeFailure", () => {
  it("collapses whitespace and caps the provider message", () => {
    const failure = describeFailure(
      model("opencode-go", "minimax-m3"),
      new Error(`401\n  ${"x".repeat(400)}`),
    );

    expect(failure.provider).toBe("opencode-go");
    expect(failure.modelId).toBe("minimax-m3");
    expect(failure.scope).toBe("provider");
    expect(failure.message.length).toBeLessThanOrEqual(241);
    expect(failure.message.startsWith("401 x")).toBe(true);
  });
});

describe("NoWorkingModelError", () => {
  it("reports one error per provider rather than the last candidate's", () => {
    const error = new NoWorkingModelError("standard", [
      describeFailure(model("opencode-go", "minimax-m3"), new Error("401 Invalid API key.")),
      describeFailure(model("opencode-go", "glm-5.2"), new Error("401 Invalid API key.")),
      describeFailure(model("github-copilot", "gpt-5.4-mini"), new Error("429 quota exceeded")),
    ]);

    expect(error.message).toBe(
      "Every available standard model failed. " +
        "opencode-go (minimax-m3): 401 Invalid API key. " +
        "github-copilot (gpt-5.4-mini): 429 quota exceeded",
    );
    expect(error.failures).toHaveLength(3);
  });

  it("still names the tier when nothing was attempted", () => {
    expect(new NoWorkingModelError("fast", []).message).toBe("Every available fast model failed.");
  });
});
