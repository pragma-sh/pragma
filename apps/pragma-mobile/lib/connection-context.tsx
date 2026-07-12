import { PragmaClient, PragmaGatewayError, type PragmaClientConfig } from "@pragma/sdk";
import { fetch as expoFetch } from "expo/fetch";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ConnectionConfig } from "./pairing";

// App-wide owner of the single PragmaClient. The chat hook and the live data
// layer both consume the client from here, so pairing state lives in exactly
// one place. Config is persisted in the device keychain (expo-secure-store) and,
// for development only, falls back to EXPO_PUBLIC_PRAGMA_GATEWAY_* env until a
// device is paired for real.

const STORE_KEY = "pragma.connection.v1";
const PROBE_TIMEOUT_MS = 10_000;

/** Whether the app has a verified, usable host connection yet. */
export type ConnectionStatus = "loading" | "paired" | "unpaired";

interface ConnectionContextValue {
  status: ConnectionStatus;
  config: ConnectionConfig | null;
  /** The shared client, or null while unpaired/loading. */
  client: PragmaClient | null;
  hostName: string | null;
  /** Persists a validated config and marks the app paired. */
  pair: (config: ConnectionConfig, hostName?: string) => Promise<void>;
  /** Clears the stored config and returns to the unpaired experience. */
  unpair: () => Promise<void>;
  /** Handles a mid-session 401: clears state and routes to re-pair. */
  handleUnauthorized: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

/** Streaming-capable fetch: Expo's fetch exposes a real ReadableStream body. */
const streamingFetch = expoFetch as unknown as NonNullable<PragmaClientConfig["fetch"]>;

/**
 * Sent on every gateway request. ngrok's free tier serves an HTML browser-warning
 * interstitial (HTTP 200, `text/html`) to browser-like User-Agents — which React
 * Native's fetch is — instead of proxying through. That HTML breaks JSON parsing
 * and makes pairing fail with a misleading "couldn't reach the desktop". This
 * header opts out of the interstitial; other hosts ignore the unknown header.
 */
const GATEWAY_HEADERS: Record<string, string> = { "ngrok-skip-browser-warning": "true" };

/** Builds a client for `config` wired to the streaming fetch. */
function clientFor(config: ConnectionConfig): PragmaClient {
  return new PragmaClient({
    baseUrl: config.url,
    token: config.token,
    fetch: streamingFetch,
    headers: GATEWAY_HEADERS,
  });
}

/** Result of probing a candidate host before persisting it. */
export type ProbeResult = { ok: true; hostName?: string } | { ok: false; reason: string };

/**
 * Verifies a candidate config is reachable and its token is accepted, by
 * calling an authed gateway endpoint through the SDK. Distinguishes an
 * unreachable host from a rejected token so the pair screen can explain which.
 */
export async function probeConnection(config: ConnectionConfig): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await clientFor(config).agents.catalog({ signal: controller.signal });
    return { ok: true };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: "The desktop didn't respond in time. Check the tunnel and try again.",
      };
    }
    if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
      return { ok: false, reason: "The desktop rejected that token. Re-scan or re-copy it." };
    }
    if (error instanceof PragmaGatewayError) {
      return {
        ok: false,
        reason:
          "The desktop is reachable but isn't ready to pair. Keep Pragma open, then try again.",
      };
    }
    return {
      ok: false,
      reason: "Couldn't reach the desktop. Check it's running and the URL is correct.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface StoredState {
  config: ConnectionConfig;
  hostName: string | null;
}

/** Reads env-provided dev config (Expo inlines EXPO_PUBLIC_* at build time). */
function devConfigFromEnv(): StoredState | null {
  const url = process.env.EXPO_PUBLIC_PRAGMA_GATEWAY_URL;
  const token = process.env.EXPO_PUBLIC_PRAGMA_GATEWAY_TOKEN;
  if (!url || !token) return null;
  return { config: { url, token }, hostName: "Dev gateway (env)" };
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("loading");
  const [stored, setStored] = useState<StoredState | null>(null);

  // Load and verify persisted config once; a stale tunnel or token must not
  // leave the app showing its paired navigation without a usable host.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await SecureStore.getItemAsync(STORE_KEY).catch(() => null);
      if (cancelled) return;
      const parsed = raw ? (safeParse(raw) ?? devConfigFromEnv()) : devConfigFromEnv();
      if (!parsed) {
        setStatus("unpaired");
        return;
      }
      const probe = await probeConnection(parsed.config);
      if (cancelled) return;
      if (probe.ok) {
        setStored(parsed);
        setStatus("paired");
        return;
      }
      await SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
      setStatus("unpaired");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const client = useMemo(() => (stored ? clientFor(stored.config) : null), [stored]);

  const pair = useCallback(async (config: ConnectionConfig, hostName?: string) => {
    const next: StoredState = { config, hostName: hostName ?? null };
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
    setStored(next);
    setStatus("paired");
  }, []);

  const unpair = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
    setStored(null);
    setStatus("unpaired");
  }, []);

  const handleUnauthorized = useCallback(() => {
    // The host regenerated its token: drop everything and force a re-pair.
    void SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
    setStored(null);
    setStatus("unpaired");
    router.replace("/pair");
  }, []);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      status,
      config: stored?.config ?? null,
      client,
      hostName: stored?.hostName ?? null,
      pair,
      unpair,
      handleUnauthorized,
    }),
    [status, stored, client, pair, unpair, handleUnauthorized],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/** Access the app-wide connection. Throws outside {@link ConnectionProvider}. */
export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) {
    throw new Error("useConnection must be used within a ConnectionProvider");
  }
  return value;
}

function safeParse(raw: string): StoredState | null {
  try {
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.config?.url && parsed.config.token) return parsed;
    return null;
  } catch {
    return null;
  }
}
