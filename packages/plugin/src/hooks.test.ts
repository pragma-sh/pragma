import { afterEach, describe, expect, it } from "vitest";
import type { PragmaBridge } from "./bridge";
import { useSdk, usePluginConfig } from "./hooks";

function clearBridge(): void {
  globalThis.__PRAGMA__ = undefined;
}

describe("plugin hooks", () => {
  afterEach(clearBridge);

  it("throw the bridge-missing error when called outside a Pragma host", () => {
    clearBridge();
    expect(() => usePluginConfig()).toThrow(/globalThis\.__PRAGMA__ is not installed/);
    expect(() => useSdk()).toThrow(/globalThis\.__PRAGMA__ is not installed/);
  });

  it("delegate to the host's installed hook implementation", () => {
    const config = { theme: "dark" };
    globalThis.__PRAGMA__ = {
      hooks: { usePluginConfig: () => config },
    } as unknown as PragmaBridge;

    expect(usePluginConfig()).toBe(config);
  });
});
