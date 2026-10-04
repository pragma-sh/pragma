import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findApiKey, parseEnvFile, parseJsonReply, userMessage } from "./model.ts";

describe("parseEnvFile", () => {
  it("reads assignments, strips quotes, and skips comments", () => {
    expect(parseEnvFile("# c\nA=1\nexport B=\"two\"\n  C = '3'\nnot a line")).toEqual({
      A: "1",
      B: "two",
      C: "3",
    });
  });
});

function file(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "jev-key-")), ".env");
  writeFileSync(path, contents);
  return path;
}

describe("findApiKey", () => {
  it("prefers the environment", () => {
    expect(findApiKey({ JEV_API_KEY: "env" }, [file("JEV_API_KEY=file")])).toBe("env");
  });

  it("reads key files in order", () => {
    expect(findApiKey({}, [file("OTHER=1"), file("OPENROUTER_API_KEY=second")])).toBe("second");
  });

  it("borrows a typesafe-computer-use key only when it is an OpenRouter key", () => {
    expect(findApiKey({}, [file("TYPESAFE_API_KEY=ts-real-key")])).toBeNull();
    expect(findApiKey({}, [file("TYPESAFE_API_KEY=sk-or-abc")])).toBe("sk-or-abc");
  });
});

describe("parseJsonReply", () => {
  it("extracts JSON from fenced or chatty replies", () => {
    expect(parseJsonReply('```json\n{"action":"done"}\n```')).toEqual({ action: "done" });
    expect(() => parseJsonReply("no json here")).toThrow(/JSON/);
  });
});

describe("userMessage", () => {
  it("attaches images as data URLs", () => {
    const message = userMessage("hi", ["AAAA"]);
    expect(message.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
