import { afterEach, describe, expect, it } from "vitest";
import { getBridge, type PragmaBridge } from "./bridge";

function clearBridge(): void {
  globalThis.__PRAGMA__ = undefined;
}

describe("getBridge", () => {
  afterEach(clearBridge);

  it("throws a clear error when the Pragma host bridge is not installed", () => {
    clearBridge();
    expect(() => getBridge()).toThrow(/globalThis\.__PRAGMA__ is not installed/);
  });

  it("returns the installed bridge once the host has set it up", () => {
    const bridge = { marker: true } as unknown as PragmaBridge;
    globalThis.__PRAGMA__ = bridge;
    expect(getBridge()).toBe(bridge);
  });
});
