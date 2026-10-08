import { describe, expect, it } from "vitest";

import {
  isTerminalViewerCommand,
  isTerminalViewerMessage,
  parseTerminalViewerMessage,
} from "./messages";

describe("isTerminalViewerCommand", () => {
  it("accepts the commands the renderer implements", () => {
    expect(isTerminalViewerCommand({ type: "write", dataBase64: "aGk=" })).toBe(true);
    expect(isTerminalViewerCommand({ type: "reset" })).toBe(true);
    expect(isTerminalViewerCommand({ type: "paste", text: "ls" })).toBe(true);
    expect(isTerminalViewerCommand({ type: "theme", css: ":root{}", mode: "dark" })).toBe(true);
  });

  it("rejects a command carrying the wrong payload", () => {
    expect(isTerminalViewerCommand({ type: "write" })).toBe(false);
    expect(isTerminalViewerCommand({ type: "write", dataBase64: 12 })).toBe(false);
    expect(isTerminalViewerCommand({ type: "paste", text: null })).toBe(false);
  });

  it("rejects anything it does not recognise rather than guessing", () => {
    expect(isTerminalViewerCommand({ type: "eval", code: "1" })).toBe(false);
    expect(isTerminalViewerCommand(null)).toBe(false);
    expect(isTerminalViewerCommand("write")).toBe(false);
  });
});

describe("isTerminalViewerMessage", () => {
  it("accepts the messages the renderer sends", () => {
    expect(isTerminalViewerMessage({ type: "ready" })).toBe(true);
    expect(isTerminalViewerMessage({ type: "input", dataBase64: "aGk=" })).toBe(true);
    expect(isTerminalViewerMessage({ type: "resize", cols: 80, rows: 24 })).toBe(true);
    expect(isTerminalViewerMessage({ type: "written", bytes: 12 })).toBe(true);
    expect(isTerminalViewerMessage({ type: "scroll", atBottom: false })).toBe(true);
  });

  it("rejects a partial resize, which would resize to NaN", () => {
    expect(isTerminalViewerMessage({ type: "resize", cols: 80 })).toBe(false);
  });
});

describe("parseTerminalViewerMessage", () => {
  it("parses a well-formed payload", () => {
    expect(parseTerminalViewerMessage('{"type":"ready"}')).toEqual({ type: "ready" });
  });

  it("returns null for malformed or foreign payloads", () => {
    // A sandboxed frame receives whatever anything else on the page posts to
    // it; unparseable and unrecognised both mean "not ours".
    expect(parseTerminalViewerMessage("not json")).toBeNull();
    expect(parseTerminalViewerMessage('{"type":"webpackHotUpdate"}')).toBeNull();
  });
});
