import { describe, expect, it } from "vitest";

import {
  buildResult,
  parseJunieUsage,
  parsePeaksFile,
  peakKey,
  PRIMARY_LIMIT_ID,
  serializePeaksFile,
} from "./usage-limits";

/** The exact report Junie 26.8.3 renders for a trial account. */
const TRIAL_REPORT = [
  "Session usage  ",
  "Here is a breakdown of the usage for the current session:  ",
  "",
  "**Total usage**  ",
  "Total tokens used: 0  ",
  "",
  "License: JetBrains Trial  ",
  "Balance left: $4.99  ",
  "Top-up: https://jb.gg/junie_top_up",
].join("\n");

describe("parseJunieUsage", () => {
  it("reads a money balance", () => {
    expect(parseJunieUsage(TRIAL_REPORT)).toEqual({
      licenseType: "JetBrains Trial",
      remaining: 4.99,
      unit: "$",
    });
  });

  it("reads a credit quota", () => {
    expect(parseJunieUsage("License: AI Pro\nQuota: 1,250 credits remaining")).toEqual({
      licenseType: "AI Pro",
      remaining: 1250,
      unit: "credits",
    });
  });

  it("returns null when Junie defers to the IDE", () => {
    expect(
      parseJunieUsage("You can check your quota by clicking the JetBrains AI icon."),
    ).toBeNull();
  });
});

describe("buildResult", () => {
  const usage = { licenseType: "JetBrains Trial", remaining: 3, unit: "$" };

  it("measures spend against the highest balance seen", () => {
    expect(buildResult(usage, 5, 1000)).toEqual({
      status: "ready",
      observedAt: 1000,
      limits: [{ id: PRIMARY_LIMIT_ID, title: "JetBrains Trial credits", used: 2, limit: 5 }],
    });
  });

  it("reads 0% used on the first observation", () => {
    expect(buildResult(usage, 3, 1000)).toMatchObject({
      limits: [expect.objectContaining({ used: 0, limit: 3 })],
    });
  });

  it("reports unavailable rather than an empty bar without a peak", () => {
    expect(buildResult({ ...usage, remaining: 0 }, 0, 1000)).toEqual({
      status: "unavailable",
      reason: "unsupported",
      message: "Junie reports no balance left.",
    });
  });
});

describe("peakKey", () => {
  it("separates licenses and units", () => {
    expect(peakKey({ licenseType: "AI Pro", remaining: 1, unit: "credits" })).toBe(
      "AI Pro|credits",
    );
    expect(peakKey({ licenseType: null, remaining: 1, unit: "$" })).toBe("unknown|$");
  });
});

describe("parsePeaksFile", () => {
  it("round-trips a valid cache", () => {
    const file = { version: 1 as const, peaks: { "AI Pro|credits": 1250 } };
    expect(parsePeaksFile(serializePeaksFile(file))).toEqual(file);
  });

  it("treats missing or corrupt input as empty", () => {
    expect(parsePeaksFile("")).toEqual({ version: 1, peaks: {} });
    expect(parsePeaksFile("not-json")).toEqual({ version: 1, peaks: {} });
    expect(parsePeaksFile('{"version":2,"peaks":{}}')).toEqual({ version: 1, peaks: {} });
  });
});
