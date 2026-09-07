import type { UsageLimitsProvider, UsageLimitsSnapshot } from "@pragma/constants";

import { routes } from "./routes";
import type { Transport } from "./transport";

/** Options for {@link UsageLimitsClient.get}. */
export interface GetUsageLimitsOptions {
  /**
   * Absolute root of the project whose scope should be reported. Providers from
   * a project-scoped plugin answer only for the project that contributed them;
   * omit to see the global and bundled providers alone.
   */
  root?: string;
  /** Narrow the response to one plugin's providers. */
  pluginId?: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for plugin-contributed usage limits.
 *
 * Readings come from the host's single cache: it owns the refresh cadence, the
 * backoff after a failing provider, and the validation every client would
 * otherwise repeat. Two clients asking at once therefore see the same numbers
 * and cost the provider one invocation, not two.
 */
export class UsageLimitsClient {
  constructor(private readonly transport: Transport) {}

  /** Fetches every provider visible in the requested scope. */
  async get(options: GetUsageLimitsOptions = {}): Promise<UsageLimitsProvider[]> {
    const snapshot = await this.transport.request<UsageLimitsSnapshot>(routes.rpc("plugins"), {
      method: "POST",
      body: {
        action: "usageLimits",
        ...(options.root ? { root: options.root } : {}),
        ...(options.pluginId ? { pluginId: options.pluginId } : {}),
      },
      signal: options.signal,
    });
    return snapshot.providers;
  }
}
