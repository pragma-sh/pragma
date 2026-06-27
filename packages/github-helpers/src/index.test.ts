import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./index";

describe("github helpers", () => {
  it("exports a GitHub client factory", () => {
    expect(typeof createGitHubClient).toBe("function");
  });
});
