import { describe, expect, it } from "vitest";

import {
  isTerminalEditingContext,
  isTextEditingContext,
  nativeEditingSequence,
} from "./native-editing";

describe("isTextEditingContext", () => {
  it("returns false for null or undefined", () => {
    expect(isTextEditingContext(null)).toBe(false);
    expect(isTextEditingContext(undefined)).toBe(false);
  });

  it("returns false for body, div, and button elements", () => {
    expect(isTextEditingContext(document.body)).toBe(false);
    expect(isTextEditingContext(document.createElement("div"))).toBe(false);
    expect(isTextEditingContext(document.createElement("button"))).toBe(false);
  });

  it("returns true for a textarea", () => {
    expect(isTextEditingContext(document.createElement("textarea"))).toBe(true);
  });

  it("returns true for text-like inputs", () => {
    for (const type of ["text", "search", "url", "email", "password", "tel", "number"]) {
      const input = document.createElement("input");
      input.type = type;
      expect(isTextEditingContext(input)).toBe(true);
    }
  });

  it("returns false for non-text inputs", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "range", "file"]) {
      const input = document.createElement("input");
      input.type = type;
      expect(isTextEditingContext(input)).toBe(false);
    }
  });

  it("returns true for an element inside .xterm", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const child = document.createElement("canvas");
    xterm.appendChild(child);
    expect(isTextEditingContext(child)).toBe(true);
  });

  it("returns true for the .xterm element itself", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    expect(isTextEditingContext(xterm)).toBe(true);
  });

  it("detects terminal editing contexts separately from other text contexts", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xterm.appendChild(helperTextarea);
    expect(isTerminalEditingContext(helperTextarea)).toBe(true);
    expect(isTerminalEditingContext(document.createElement("textarea"))).toBe(false);
  });

  it("returns true for an element inside .cm-editor", () => {
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const child = document.createElement("div");
    cm.appendChild(child);
    expect(isTextEditingContext(child)).toBe(true);
  });

  it("returns true for an element inside [role=textbox]", () => {
    const host = document.createElement("div");
    host.setAttribute("role", "textbox");
    const child = document.createElement("span");
    host.appendChild(child);
    expect(isTextEditingContext(child)).toBe(true);
  });
});

describe("nativeEditingSequence — mac", () => {
  it("maps Cmd+Backspace to Ctrl+U (delete to beginning of line)", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "Backspace" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x15");
  });

  it("maps Cmd+Left to Ctrl+A (beginning of line)", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "ArrowLeft" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x01");
  });

  it("maps Cmd+Right to Ctrl+E (end of line)", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "ArrowRight" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x05");
  });

  it("maps Option+Left to ESC+B (back word)", () => {
    const event = new KeyboardEvent("keydown", { altKey: true, key: "ArrowLeft" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x1bb");
  });

  it("maps Option+Right to ESC+F (forward word)", () => {
    const event = new KeyboardEvent("keydown", { altKey: true, key: "ArrowRight" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x1bf");
  });

  it("maps Option+Backspace to Ctrl+W (delete word backward)", () => {
    const event = new KeyboardEvent("keydown", { altKey: true, key: "Backspace" });
    expect(nativeEditingSequence(event, "mac")).toBe("\x17");
  });

  it("returns null when Shift is held (leave selection to xterm)", () => {
    const event = new KeyboardEvent("keydown", {
      metaKey: true,
      shiftKey: true,
      key: "ArrowLeft",
    });
    expect(nativeEditingSequence(event, "mac")).toBeNull();
  });

  it("returns null when extra modifiers are held", () => {
    const cmdAlt = new KeyboardEvent("keydown", {
      metaKey: true,
      altKey: true,
      key: "Backspace",
    });
    expect(nativeEditingSequence(cmdAlt, "mac")).toBeNull();
  });

  it("returns null for an unhandled key", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "a" });
    expect(nativeEditingSequence(event, "mac")).toBeNull();
  });

  it("returns null for a non-keydown event", () => {
    const event = new KeyboardEvent("keyup", { metaKey: true, key: "Backspace" });
    expect(nativeEditingSequence(event, "mac")).toBeNull();
  });
});

describe("nativeEditingSequence — linux", () => {
  it("maps Ctrl+Left to ESC+B (back word)", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "ArrowLeft" });
    expect(nativeEditingSequence(event, "linux")).toBe("\x1bb");
  });

  it("maps Ctrl+Right to ESC+F (forward word)", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "ArrowRight" });
    expect(nativeEditingSequence(event, "linux")).toBe("\x1bf");
  });

  it("maps Ctrl+Backspace to Ctrl+W (delete word backward)", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "Backspace" });
    expect(nativeEditingSequence(event, "linux")).toBe("\x17");
  });

  it("maps Ctrl+Delete to ESC+D (delete word forward)", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "Delete" });
    expect(nativeEditingSequence(event, "linux")).toBe("\x1bd");
  });

  it("returns null for Cmd-modified keys on linux", () => {
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "Backspace" });
    expect(nativeEditingSequence(event, "linux")).toBeNull();
  });

  it("returns null when Shift is held", () => {
    const event = new KeyboardEvent("keydown", {
      ctrlKey: true,
      shiftKey: true,
      key: "ArrowLeft",
    });
    expect(nativeEditingSequence(event, "linux")).toBeNull();
  });
});
