import type { PushTestResult } from "@pragma/sdk";

import type { PushRegistration } from "./push";

// The settings notification check, reduced to something a person can act on.
// Push has several independent ways to be silent — permission, a build with no
// push service, a host with no phones registered, a push service that refuses
// the message — and none of them announce themselves. The pure mapping lives
// here (and is tested) so the screen is only wiring.

/** State of the most recent notification check. */
export type PushCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; summary: string }
  | { kind: "failed"; reason: string };

/** Why this device could not be registered for push, in the user's terms. */
export function registrationFailure(registration: PushRegistration): PushCheckState | null {
  if (registration.ok) return null;
  switch (registration.reason) {
    case "denied":
      return {
        kind: "failed",
        reason:
          "Notifications are turned off for Pragma Go. Turn them on in the system Settings app, then check again.",
      };
    case "unsupported":
      return {
        kind: "failed",
        reason:
          "This build can't receive push notifications. A simulator and the browser have no push service to register with.",
      };
    case "cancelled":
      return { kind: "failed", reason: "The check was cancelled." };
    case "failed":
      return {
        kind: "failed",
        reason:
          "Couldn't register this device with the desktop. Check the connection, then try again.",
      };
  }
}

/**
 * What the host's test push actually did. A rejection is reported verbatim
 * because the push service's own wording (`InvalidCredentials`, a rate limit)
 * is the part that says what to fix.
 */
export function testOutcome(result: PushTestResult): PushCheckState {
  if (result.errors.length > 0) {
    return { kind: "failed", reason: `The push service refused it — ${result.errors.join(" · ")}` };
  }
  if (result.sent === 0) {
    return {
      kind: "failed",
      reason: "The desktop has no phones registered for notifications, including this one.",
    };
  }
  return {
    kind: "ok",
    summary: `Sent to ${deviceCount(result.sent)}. A banner should arrive in a moment.`,
  };
}

/** One-line summary of a notification check. */
export function pushCheckSummary(state: PushCheckState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return "Checking…";
    case "ok":
      return state.summary;
    case "failed":
      return state.reason;
  }
}

function deviceCount(count: number): string {
  return count === 1 ? "1 device" : `${count} devices`;
}
