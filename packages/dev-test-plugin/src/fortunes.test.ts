import { describe, expect, it } from "vitest";

import { FORTUNES, pickFortune } from "./fortunes";

describe("fortunes", () => {
  it("ships a non-empty, non-blank rotation", () => {
    expect(FORTUNES.length).toBeGreaterThan(0);
    for (const fortune of FORTUNES) {
      expect(fortune.length).toBeGreaterThan(0);
    }
  });

  it("picks a deterministic fortune from an injected rng", () => {
    expect(pickFortune(() => 0)).toBe(FORTUNES[0]);
    expect(pickFortune(() => 0.5)).toBe(FORTUNES[Math.floor(0.5 * FORTUNES.length)]);
  });
});
