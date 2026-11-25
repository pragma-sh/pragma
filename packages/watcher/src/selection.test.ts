import { describe, expect, it } from "vitest";

import { parseLaunchSelection } from "./selection";

describe("parseLaunchSelection", () => {
  it("keeps the choices a launch made and drops the unset ones", () => {
    expect(
      parseLaunchSelection(
        JSON.stringify({ modelId: "openai/gpt", reasoningId: null, modeId: "plan" }),
      ),
    ).toEqual({ modelId: "openai/gpt", modeId: "plan" });
  });

  it("reads a missing or unreadable argument as no selection", () => {
    expect(parseLaunchSelection(undefined)).toBeUndefined();
    expect(parseLaunchSelection("{not json")).toBeUndefined();
    expect(parseLaunchSelection("3")).toBeUndefined();
  });
});
