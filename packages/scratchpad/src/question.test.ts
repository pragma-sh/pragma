import { describe, expect, it } from "vitest";

import { OTHER_VALUE, composeAnswer, toggleChoice } from "./question";

describe("toggleChoice", () => {
  it("replaces the selection for a single-answer list", () => {
    expect(toggleChoice(["a"], "b", false)).toEqual(["b"]);
    expect(toggleChoice(["a"], "a", false)).toEqual(["a"]);
  });

  it("adds and removes entries for a multi-select list", () => {
    expect(toggleChoice([], "a", true)).toEqual(["a"]);
    expect(toggleChoice(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleChoice(["a", "b"], "a", true)).toEqual(["b"]);
  });
});

describe("composeAnswer", () => {
  it("joins multiple selections with commas", () => {
    expect(composeAnswer(["a", "b"], "")).toBe("a, b");
  });

  it("substitutes the typed text for the Other choice", () => {
    expect(composeAnswer([OTHER_VALUE], "  something else  ")).toBe("something else");
    expect(composeAnswer(["a", OTHER_VALUE], "extra")).toBe("a, extra");
  });

  it("is empty while Other is selected but unfilled", () => {
    expect(composeAnswer([OTHER_VALUE], "   ")).toBe("");
    expect(composeAnswer([], "typed")).toBe("");
  });
});
