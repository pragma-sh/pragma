import type { AgentCatalog, CatalogAgent } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useEffect, useState } from "react";

import { useConnection } from "./connection-context";
import { runtimeAgentId } from "./launch-form";

const CATALOG_RETRY_MS = 500;
const CATALOG_RETRY_MAX_MS = 10_000;

/**
 * One in-flight load and one result per client, shared by every hook instance.
 * Agent icons are resolved per row (a worktree lists many sessions), and a
 * catalog fetch — with its retry loop — must not be repeated once per row.
 */
const catalogState: {
  client: unknown;
  catalog: AgentCatalog | null;
  /** A load loop is running; further mounts subscribe instead of starting one. */
  loading: boolean;
  listeners: Set<(catalog: AgentCatalog) => void>;
} = { client: null, catalog: null, loading: false, listeners: new Set() };

/** Drops any cached catalog when the paired host changes. */
function resetCatalogState(client: unknown): void {
  if (catalogState.client === client) return;
  catalogState.client = client;
  catalogState.catalog = null;
  catalogState.loading = false;
}

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
    resetCatalogState(client);
    if (!client) {
      setCatalog(null);
      return undefined;
    }
    // Subscribe even when a catalog is already cached: the first load publishes
    // every attempt, and an early empty catalog is followed by the real one.
    if (catalogState.catalog) setCatalog(catalogState.catalog);
    catalogState.listeners.add(setCatalog);
    if (!catalogState.loading) {
      catalogState.loading = true;
      void loadCatalog(client, publishCatalog, handleUnauthorized, () => {
        return client !== catalogState.client;
      });
    }
    return () => {
      catalogState.listeners.delete(setCatalog);
    };
  }, [client, handleUnauthorized]);

  return catalog;
}

/** Stores a loaded catalog and hands it to every mounted subscriber. */
function publishCatalog(catalog: AgentCatalog): void {
  catalogState.catalog = catalog;
  for (const listener of catalogState.listeners) listener(catalog);
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
  return catalogAgentById(useCatalog(), agentId);
}

/**
 * Pure lookup behind [`useCatalogAgent`], for callers that already hold the
 * catalog — a list resolves one catalog for all of its rows.
 */
export function catalogAgentById(
  catalog: AgentCatalog | null,
  agentId: string | undefined,
): CatalogAgent | undefined {
  if (!agentId || !catalog) return undefined;
  return (
    catalog.agents.find((agent) => agent.id === agentId) ??
    catalog.agents.find((agent) => runtimeAgentId(agent.id) === agentId)
  );
}
