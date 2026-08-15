import { PragmaGatewayError } from "@pragma/sdk";
import type { GatewayHealth, PragmaClient } from "@pragma/sdk";

// The settings heartbeat: one `/v1/health` round trip, reduced to something a
// person can read. The pure parts live here (and are tested) so the screen is
// only wiring.

/** How long a heartbeat may take before it counts as unreachable. */
export const HEARTBEAT_TIMEOUT_MS = 8_000;

/** State of the most recent heartbeat check. */
export type HeartbeatState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; latencyMs: number; health: GatewayHealth }
  | { kind: "failed"; reason: string };

/** Turns a failed heartbeat into a reason the user can act on. */
export function heartbeatFailure(error: unknown, timedOut: boolean): HeartbeatState {
  if (timedOut) return { kind: "failed", reason: "The desktop didn't answer in time." };
  if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
    return { kind: "failed", reason: "The desktop rejected this device's token. Pair again." };
  }
  return { kind: "failed", reason: "Couldn't reach the desktop. Check that Pragma is running." };
}

/** One-line summary of a heartbeat result. */
export function heartbeatSummary(state: HeartbeatState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return "Checking…";
    case "ok":
      return `${state.health.status} · ${state.latencyMs} ms · gateway ${state.health.gatewayVersion} · protocol v${state.health.protocolVersion}`;
    case "failed":
      return state.reason;
  }
}

/** Runs one heartbeat against `client`, resolving to the state to display. */
export async function checkHeartbeat(client: PragmaClient): Promise<HeartbeatState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const health = await client.health.check({ signal: controller.signal });
    return { kind: "ok", latencyMs: Date.now() - startedAt, health };
  } catch (error) {
    return heartbeatFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timeout);
  }
}
