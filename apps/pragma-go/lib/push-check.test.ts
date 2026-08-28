import { describe, expect, it } from "vitest";

import { pushCheckSummary, registrationFailure, testOutcome } from "./push-check";

describe("registrationFailure", () => {
  it("passes a successful registration through", () => {
    expect(registrationFailure({ ok: true, token: "ExponentPushToken[x]" })).toBeNull();
  });

  it("names the system setting when permission was refused", () => {
    const state = registrationFailure({ ok: false, reason: "denied" });
    expect(state).toMatchObject({ kind: "failed" });
    expect(state && "reason" in state ? state.reason : "").toContain("Settings app");
  });

  it("explains a build with no push service", () => {
    const state = registrationFailure({ ok: false, reason: "unsupported" });
    expect(state && "reason" in state ? state.reason : "").toContain("simulator");
  });
});

describe("testOutcome", () => {
  it("reports the push service's own rejection", () => {
    expect(testOutcome({ sent: 1, errors: ["InvalidCredentials: no APNs key"] })).toEqual({
      kind: "failed",
      reason: "The push service refused it — InvalidCredentials: no APNs key",
    });
  });

  it("tells an empty registry apart from a delivered push", () => {
    expect(testOutcome({ sent: 0, errors: [] })).toMatchObject({ kind: "failed" });
    expect(testOutcome({ sent: 1, errors: [] })).toEqual({
      kind: "ok",
      summary: "Sent to 1 device. A banner should arrive in a moment.",
    });
    expect(testOutcome({ sent: 3, errors: [] })).toMatchObject({
      summary: "Sent to 3 devices. A banner should arrive in a moment.",
    });
  });
});

describe("pushCheckSummary", () => {
  it("has nothing to say before a check has run", () => {
    expect(pushCheckSummary({ kind: "idle" })).toBeNull();
    expect(pushCheckSummary({ kind: "checking" })).toBe("Checking…");
  });
});
