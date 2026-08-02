import { describe, expect, it } from "vitest";

import { asNumber, findResponse, shellQuote } from "./acp";
import { parseGrokUsage } from "./usage-limits";

const OBSERVED_AT = Date.parse("2026-07-30T00:00:00Z");

/** The exact `_x.ai/billing` result shape grok 0.2.114 returns for a free account. */
const FREE_ACCOUNT = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-29T00:00:00+00:00",
      end: "2026-08-05T00:00:00+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: "2026-07-29T00:00:00+00:00",
    billingPeriodEnd: "2026-08-05T00:00:00+00:00",
  },
  subscription_tier: "Free",
};

describe("parseGrokUsage", () => {
  it("reports a percentage window against the current billing period", () => {
    const result = parseGrokUsage(
      {
        config: { ...FREE_ACCOUNT.config, creditUsagePercent: 42.5 },
        subscription_tier: "SuperGrok",
      },
      OBSERVED_AT,
    );
    expect(result).toEqual({
      status: "ready",
      observedAt: OBSERVED_AT,
      limits: [
        {
          id: "credits",
          title: "Weekly credits",
          used: 42.5,
          limit: 100,
          resetsInMs: Date.parse("2026-08-05T00:00:00Z") - OBSERVED_AT,
        },
      ],
    });
  });

  it("clamps an out-of-range percentage", () => {
    const result = parseGrokUsage(
      { config: { creditUsagePercent: 140 }, subscription_tier: "SuperGrok" },
      OBSERVED_AT,
    );
    expect(result).toMatchObject({ status: "ready", limits: [{ used: 100, limit: 100 }] });
  });

  it("falls back to the included allowance when no percentage is reported", () => {
    const result = parseGrokUsage(
      {
        config: {
          billingCycle: "monthly",
          monthlyLimit: { val: 250 },
          includedUsed: { val: 30 },
          billingPeriodEnd: "2026-08-01T00:00:00+00:00",
        },
      },
      OBSERVED_AT,
    );
    expect(result).toMatchObject({
      status: "ready",
      limits: [{ id: "credits", title: "Monthly credits", used: 30, limit: 250 }],
    });
  });

  it("adds the pay-as-you-go window only when a cap is set", () => {
    const capped = parseGrokUsage(
      {
        config: {
          ...FREE_ACCOUNT.config,
          creditUsagePercent: 10,
          onDemandCap: { val: 50 },
          onDemandUsed: { val: 12.5 },
        },
      },
      OBSERVED_AT,
    );
    expect(capped).toMatchObject({
      status: "ready",
      limits: [
        { id: "credits" },
        { id: "on-demand", title: "On-demand spend", used: 12.5, limit: 50 },
      ],
    });
    const uncapped = parseGrokUsage(
      { config: { ...FREE_ACCOUNT.config, creditUsagePercent: 10 } },
      OBSERVED_AT,
    );
    expect(uncapped).toMatchObject({ status: "ready", limits: [{ id: "credits" }] });
  });

  it("reports a free account with no finite window as unsupported", () => {
    expect(parseGrokUsage(FREE_ACCOUNT, OBSERVED_AT)).toEqual({
      status: "unavailable",
      reason: "unsupported",
      message: "Grok did not report usage windows for the Free plan.",
    });
  });

  it("omits the reset when the period has no parsable end", () => {
    const result = parseGrokUsage(
      { config: { creditUsagePercent: 5, currentPeriod: { end: "not-a-date" } } },
      OBSERVED_AT,
    );
    expect(result).toMatchObject({ status: "ready", limits: [{ id: "credits" }] });
    expect(result).toEqual({
      status: "ready",
      observedAt: OBSERVED_AT,
      limits: [{ id: "credits", title: "Credits", used: 5, limit: 100 }],
    });
  });

  it("throws on a non-object payload so the host retries instead of caching a bad state", () => {
    expect(() => parseGrokUsage("nope", OBSERVED_AT)).toThrow(/not an object/);
  });
});

describe("acp helpers", () => {
  it("matches a response by id across interleaved notifications", () => {
    const stdout = [
      '{"jsonrpc":"2.0","method":"_x.ai/announcements/update","params":{}}',
      "not json at all",
      '{"jsonrpc":"2.0","id":2,"result":{"subscription_tier":"Free"}}',
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}',
    ].join("\n");
    expect(findResponse(stdout, 2)).toEqual({ ok: true, result: { subscription_tier: "Free" } });
    expect(findResponse(stdout, 1)).toEqual({ ok: true, result: { protocolVersion: 1 } });
    expect(findResponse(stdout, 9)).toBeUndefined();
  });

  it("surfaces a JSON-RPC error as a failed response", () => {
    const stdout = '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}';
    expect(findResponse(stdout, 2)).toEqual({ ok: false, message: "Method not found" });
  });

  it("unwraps grok's `{ val }` money wrapper", () => {
    expect(asNumber({ val: 12.5 })).toBe(12.5);
    expect(asNumber(3)).toBe(3);
    expect(asNumber({ val: "3" })).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
  });

  it("escapes embedded single quotes for POSIX sh", () => {
    expect(shellQuote(`a'b`)).toBe(`'a'"'"'b'`);
  });
});
