import { describe, expect, it } from "vitest";

import {
  askAttentionFields,
  askQuestions,
  type OmpFormModules,
  type OmpHtmlForm,
} from "./ask-form";

function modules(form: OmpHtmlForm, labels: string[]): OmpFormModules {
  return {
    parseHtmlForm: () => form,
    fieldQuestions: (parsed) =>
      new Map(parsed.fields.map((field, index) => [field, labels[index] ?? ""])),
  };
}

const option = (text: string, disabled = false) => ({ label: [{ text }], disabled });

describe("askQuestions", () => {
  it("lists enabled radio and checkbox options in dialog order", () => {
    const form: OmpHtmlForm = {
      fields: [
        {
          kind: "choice",
          name: "db",
          options: [option("Postgres"), option("Off", true), option("SQLite")],
        },
        { kind: "choice", name: "ci", multi: true, options: [option("GitHub"), option("RWX")] },
      ],
    };
    expect(askQuestions("<form>", modules(form, ["Database", "CI"]))).toEqual([
      { question: "Database", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      { question: "CI", options: [{ label: "GitHub" }, { label: "RWX" }] },
    ]);
  });

  it("reports text inputs and single dropdowns as free-text questions", () => {
    const form: OmpHtmlForm = {
      fields: [
        { kind: "text", name: "notes" },
        { kind: "choice", name: "tier", select: true, options: [option("Free"), option("Pro")] },
        { kind: "choice", name: "tags", select: true, multi: true, options: [option("a")] },
      ],
    };
    expect(askQuestions("<form>", modules(form, ["Notes", "Tier", ""]))).toEqual([
      { question: "Notes" },
      { question: "Tier" },
      // A multi-select draws option rows; an unlabelled field falls back to its name.
      { question: "tags", options: [{ label: "a" }] },
    ]);
  });
});

describe("askAttentionFields", () => {
  const red = { question: "Choose Red or Blue?", options: [{ label: "Red" }, { label: "Blue" }] };
  const shape = { question: "Circle or Square?", options: [{ label: "Circle" }] };

  it("sends one field as question and options", () => {
    expect(askAttentionFields([red])).toEqual(red);
    expect(askAttentionFields([{ question: "Notes" }])).toEqual({ question: "Notes" });
  });

  it("headlines a multi-field form with its first question and sends the batch", () => {
    expect(askAttentionFields([red, shape])).toEqual({
      question: "Choose Red or Blue?",
      questions: [red, shape],
    });
  });

  it("never sends an empty question", () => {
    expect(askAttentionFields([]).question).not.toBe("");
    expect(askAttentionFields([{ question: "  " }]).question).not.toBe("");
  });
});
