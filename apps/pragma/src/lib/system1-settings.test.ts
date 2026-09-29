import { describe, expect, it } from "vitest";

import {
  applySystem1Patch,
  defaultSystem1Model,
  validateSystem1Settings,
} from "./system1-settings";

describe("applySystem1Patch", () => {
  it("sets trimmed values and keeps unrelated config", () => {
    const config: { plugins: string[]; system1?: { baseUrl?: string } } = { plugins: [] };
    expect(applySystem1Patch(config, { baseUrl: " https://jev.example " })).toEqual({
      plugins: [],
      system1: { baseUrl: "https://jev.example" },
    });
  });

  it("removes a blank field and drops an emptied block", () => {
    expect(
      applySystem1Patch({ system1: { baseUrl: "https://x", model: "jev-1" } }, { baseUrl: "" }),
    ).toEqual({ system1: { model: "jev-1" } });
    expect(
      applySystem1Patch({ other: 1, system1: { baseUrl: "https://x" } }, { baseUrl: undefined }),
    ).toEqual({
      other: 1,
    });
  });
});

describe("validateSystem1Settings", () => {
  it("accepts absent and well-typed blocks", () => {
    expect(() => validateSystem1Settings(undefined)).not.toThrow();
    expect(() => validateSystem1Settings({ baseUrl: "https://x", model: "jev" })).not.toThrow();
  });

  it("rejects the wrong shapes", () => {
    expect(() => validateSystem1Settings([] as never)).toThrow("system1 must be an object");
    expect(() => validateSystem1Settings({ baseUrl: 3 } as never)).toThrow(
      "system1.baseUrl must be a string",
    );
  });
});

describe("defaultSystem1Model", () => {
  it("follows the endpoint host", () => {
    expect(defaultSystem1Model("https://openrouter.ai/api/alpha/decisions")).toBe(
      "~typesafe/jev-latest",
    );
    expect(defaultSystem1Model("https://api.typesafe.ai")).toBe("jev-latest");
    expect(defaultSystem1Model("not a url")).toBe("jev-latest");
  });
});
