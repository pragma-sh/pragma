import { describe, expect, it } from "vitest";

import { normalizeQuestionOptions, normalizeQuestions } from "./types";

describe("normalizeQuestionOptions", () => {
  it("returns undefined for non-array input", () => {
    expect(normalizeQuestionOptions(undefined)).toBeUndefined();
    expect(normalizeQuestionOptions(null)).toBeUndefined();
    expect(normalizeQuestionOptions("Yes")).toBeUndefined();
  });

  it("normalizes plain string options", () => {
    expect(normalizeQuestionOptions(["Yes", "No"])).toEqual([{ label: "Yes" }, { label: "No" }]);
  });

  it("normalizes object options, trimming label and description", () => {
    expect(normalizeQuestionOptions([{ label: " Yes ", description: " confirms it " }])).toEqual([
      { label: "Yes", description: "confirms it" },
    ]);
  });

  it("drops an object option with an empty description", () => {
    expect(normalizeQuestionOptions([{ label: "Yes", description: "  " }])).toEqual([
      { label: "Yes" },
    ]);
  });

  it("drops malformed entries (blank labels, wrong shapes) and keeps the rest", () => {
    expect(
      normalizeQuestionOptions(["", "  ", 42, null, { description: "no label" }, "No"]),
    ).toEqual([{ label: "No" }]);
  });

  it("returns undefined when every entry is malformed or empty", () => {
    expect(normalizeQuestionOptions(["", "  ", null, 42])).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(normalizeQuestionOptions([])).toBeUndefined();
  });
});

describe("normalizeQuestions", () => {
  it("returns undefined for non-array input", () => {
    expect(normalizeQuestions(undefined)).toBeUndefined();
    expect(normalizeQuestions(null)).toBeUndefined();
    expect(normalizeQuestions("Which auth method?")).toBeUndefined();
  });

  it("normalizes a plain string question with no options", () => {
    expect(normalizeQuestions([" Which auth method? "])).toEqual([
      { question: "Which auth method?", options: [] },
    ]);
  });

  it("normalizes an object question with options", () => {
    expect(
      normalizeQuestions([
        { question: "Which auth method?", options: ["OAuth", { label: "API key" }] },
      ]),
    ).toEqual([
      {
        question: "Which auth method?",
        options: [{ label: "OAuth" }, { label: "API key" }],
      },
    ]);
  });

  it("normalizes an object question with no options to an empty options array", () => {
    expect(normalizeQuestions([{ question: "Continue?" }])).toEqual([
      { question: "Continue?", options: [] },
    ]);
  });

  it("drops malformed entries (blank text, wrong shapes) and keeps the rest", () => {
    expect(
      normalizeQuestions(["", "  ", 42, null, { options: ["no question text"] }, "And the DB?"]),
    ).toEqual([{ question: "And the DB?", options: [] }]);
  });

  it("returns undefined when every entry is malformed or empty", () => {
    expect(normalizeQuestions(["", "  ", null, {}])).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(normalizeQuestions([])).toBeUndefined();
  });
});
