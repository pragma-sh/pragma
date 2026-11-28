import { describe, expect, it } from "vitest";

import { DEFAULT_INTERRUPT_KEYS, interruptKeysFor } from "./interrupt";

describe("interruptKeysFor", () => {
  it("defaults to Escape", () => {
    expect(interruptKeysFor({})).toBe("\x1b");
    expect(DEFAULT_INTERRUPT_KEYS).toBe("\x1b");
  });

  it("uses the keys a watcher declares", () => {
    // Grok cancels on Ctrl+C; Escape opens its scrollback.
    expect(interruptKeysFor({ interruptKeys: "\x03" })).toBe("\x03");
  });

  it("ignores an empty or malformed declaration", () => {
    expect(interruptKeysFor({ interruptKeys: "" })).toBe("\x1b");
    expect(interruptKeysFor({ interruptKeys: 3 })).toBe("\x1b");
  });
});
