import { routes } from "./routes";
import type { Transport } from "./transport";

/** Body of `GET /v1/health`. */
export interface GatewayHealth {
  status: string;
  protocolVersion: number;
  gatewayVersion: string;
}

/**
 * Gateway namespace for the liveness probe.
 *
 * `/v1/health` is one of the gateway's unauthenticated routes, so this answers
 * even when a token has gone stale — which is what makes it useful for telling
 * "the host is gone" apart from "the host rejected us".
 */
export class HealthClient {
  constructor(private readonly transport: Transport) {}

  /** Fetches the host's health, including its protocol and gateway versions. */
  check(options: { signal?: AbortSignal } = {}): Promise<GatewayHealth> {
    return this.transport.request<GatewayHealth>(routes.health, { signal: options.signal });
  }
}
