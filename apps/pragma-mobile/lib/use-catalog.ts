import type { AgentCatalog, CatalogAgent } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useEffect, useState } from "react";

import { useConnection } from "./connection-context";
import { runtimeAgentId } from "./launch-form";

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
    void loadCatalog(client, setCatalog, handleUnauthorized, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized]);

  return catalog;
}

async function loadCatalog(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
  onCatalog: (catalog: AgentCatalog) => void,
  onUnauthorized: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  let backoff = CATALOG_RETRY_MS;
  while (!isCancelled()) {
    const result = await fetchCatalog(client, onCatalog, onUnauthorized, isCancelled);
    if (result === "stop") return;
    backoff = result === "empty" ? CATALOG_RETRY_MS : Math.min(backoff * 2, CATALOG_RETRY_MAX_MS);
    // oxlint-disable-next-line no-await-in-loop -- backoff between retries.
    await delay(backoff);
  }
}

async function fetchCatalog(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
  onCatalog: (catalog: AgentCatalog) => void,
  onUnauthorized: () => void,
  isCancelled: () => boolean,
): Promise<"empty" | "retry" | "stop"> {
  const result = await requestCatalog(client);
  if (isCancelled()) return "stop";
  return catalogResult(result, onCatalog, onUnauthorized);
}

async function requestCatalog(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
): Promise<AgentCatalog | "retry" | "unauthorized"> {
  try {
    return await client.agents.catalog();
  } catch (error) {
    return catalogFailure(error);
  }
}

function catalogFailure(error: unknown): "retry" | "unauthorized" {
  return error instanceof PragmaGatewayError && error.httpStatus === 401 ? "unauthorized" : "retry";
}

function catalogResult(
  result: AgentCatalog | "retry" | "unauthorized",
  onCatalog: (catalog: AgentCatalog) => void,
  onUnauthorized: () => void,
): "empty" | "retry" | "stop" {
  if (result === "unauthorized") {
    onUnauthorized();
    return "stop";
  }
  if (result === "retry") return "retry";
  onCatalog(result);
  return result.agents.length > 0 ? "stop" : "empty";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One catalog agent by id (e.g. to resolve its icon + display name).
 *
 * Accepts either the catalog-qualified id (`pragma.claude-code`) or the
 * runtime stream id tabs and agent reports carry (`claude-code`) — both are
 * how the rest of the app names an agent, and icons must resolve either way.
 */
export function useCatalogAgent(agentId: string | undefined): CatalogAgent | undefined {
  const catalog = useCatalog();
  if (!agentId || !catalog) return undefined;
  return (
    catalog.agents.find((agent) => agent.id === agentId) ??
    catalog.agents.find((agent) => runtimeAgentId(agent.id) === agentId)
  );
}
