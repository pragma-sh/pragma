import { describe, expect, it } from "vitest";

import { listAuthMethods } from "./auth.ts";

describe("listAuthMethods", () => {
  const methods = listAuthMethods();
  const featured = methods.filter((m) => m.featured);

  it("features the six chosen providers in order", () => {
    expect(featured.map((m) => `${m.kind}:${m.provider}`)).toEqual([
      "oauth:anthropic",
      "oauth:openai-codex",
      "api-key:openrouter",
      "oauth:github-copilot",
      "api-key:google",
      "api-key:opencode-go",
    ]);
  });

  it("lists additional providers behind the featured set", () => {
    expect(methods.length).toBeGreaterThan(featured.length);
    expect(
      methods.some((m) => !m.featured && m.kind === "api-key" && m.provider === "openai"),
    ).toBe(true);
  });

  it("does not offer API keys for ambient-credential providers", () => {
    expect(methods.some((m) => m.kind === "api-key" && m.provider === "amazon-bedrock")).toBe(
      false,
    );
    expect(methods.some((m) => m.kind === "api-key" && m.provider === "google-vertex")).toBe(false);
  });

  it("never duplicates a (provider, kind) method", () => {
    const keys = methods.map((m) => `${m.kind}:${m.provider}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
