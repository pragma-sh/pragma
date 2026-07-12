import type { AgentCatalog, CatalogAgent } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useEffect, useState } from "react";

import { useConnection } from "./connection-context";

const CATALOG_RETRY_MS = 500;
const CATALOG_RETRY_MAX_MS = 10_000;

/**
 * The launchable-agent catalog for the paired host, or `null` until loaded.
 * Retries with capped backoff until agents arrive: the host starts its plugin
 * catalog lazily (first responses can be empty) and a transient tunnel error
 * must not permanently blank the launch sheet. A 401 means the host token was
 * regenerated, so the shared unauthorized flow routes back to pairing.
 */
export function useCatalog(): AgentCatalog | null {
  const { client, handleUnauthorized } = useConnection();
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);

  useEffect(() => {
    if (!client) {
      setCatalog(null);
      return undefined;
    }
    let cancelled = false;
    let backoff = CATALOG_RETRY_MS;
    void (async () => {
      for (;;) {
        if (cancelled) return;
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential retry attempts.
          const result = await client.agents.catalog();
          if (cancelled) return;
          setCatalog(result);
          // Server starts plugin catalog lazily; don't retain its first empty response.
          if (result.agents.length > 0) return;
          backoff = CATALOG_RETRY_MS;
        } catch (error) {
          if (cancelled) return;
          if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
            handleUnauthorized();
            return;
          }
          backoff = Math.min(backoff * 2, CATALOG_RETRY_MAX_MS);
        }
        // oxlint-disable-next-line no-await-in-loop -- backoff between retries.
        await delay(backoff);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized]);

  return catalog;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One catalog agent by id (e.g. to resolve its icon + display name). */
export function useCatalogAgent(agentId: string | undefined): CatalogAgent | undefined {
  const catalog = useCatalog();
  if (!agentId) return undefined;
  return catalog?.agents.find((agent) => agent.id === agentId);
}
