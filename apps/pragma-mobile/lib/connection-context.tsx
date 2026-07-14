import { PragmaClient, PragmaGatewayError, type PragmaClientConfig } from "@pragma/sdk";
import { fetch as expoFetch } from "expo/fetch";
import Constants from "expo-constants";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
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
import { constants } from "@pragma/constants";

// App-wide owner of the single PragmaClient. The chat hook and the live data
// layer both consume the client from here, so pairing state lives in exactly
// one place. Config is persisted in the device keychain (expo-secure-store) and,
// for development only, falls back to EXPO_PUBLIC_PRAGMA_GATEWAY_* env until a
// device is paired for real.

const STORE_KEY = "pragma.connection.v1";
const DEVICE_ID_STORE_KEY = "pragma.device-id.v1";
const PROBE_TIMEOUT_MS = 10_000;

/** Whether the app has a verified, usable host connection yet. */
type ConnectionStatus = "loading" | "paired" | "unpaired";

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
let deviceHeadersPromise: Promise<Record<string, string>> | null = null;

function gatewayHeaders(): Promise<Record<string, string>> {
  if (deviceHeadersPromise) return deviceHeadersPromise;
  const pending = SecureStore.getItemAsync(DEVICE_ID_STORE_KEY).then(async (storedId) => {
    const id = storedId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!storedId) await SecureStore.setItemAsync(DEVICE_ID_STORE_KEY, id);
    const headers = constants.gateway.deviceHeaders;
    return {
      "ngrok-skip-browser-warning": "true",
      [headers.id]: id,
      [headers.name]: Platform.OS === "ios" ? "iPhone or iPad" : "Android device",
      [headers.platform]: Platform.OS,
      [headers.appVersion]: Constants.expoConfig?.version ?? "unknown",
    };
  });
  deviceHeadersPromise = pending.catch((error: unknown) => {
    deviceHeadersPromise = null;
    throw error;
  });
  return deviceHeadersPromise;
}

/** Builds a client for `config` wired to the streaming fetch. */
async function clientFor(config: ConnectionConfig): Promise<PragmaClient> {
  return new PragmaClient({
    baseUrl: config.url,
    token: config.token,
    fetch: streamingFetch,
    headers: await gatewayHeaders(),
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
    await (await clientFor(config)).agents.catalog({ signal: controller.signal });
    return { ok: true };
  } catch (error) {
    return probeFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timeout);
  }
}

function probeFailure(error: unknown, timedOut: boolean): ProbeResult {
  if (timedOut)
    return {
      ok: false,
      reason: "The desktop didn't respond in time. Check the tunnel and try again.",
    };
  if (error instanceof PragmaGatewayError) return gatewayProbeFailure(error);
  return {
    ok: false,
    reason: "Couldn't reach the desktop. Check it's running and the URL is correct.",
  };
}

function gatewayProbeFailure(error: PragmaGatewayError): ProbeResult {
  if (error.httpStatus === 401) {
    return { ok: false, reason: "The desktop rejected that token. Re-scan or re-copy it." };
  }
  return {
    ok: false,
    reason: "The desktop is reachable but isn't ready to pair. Keep Pragma open, then try again.",
  };
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

  useRestoredConnection(setStored, setStatus);

  const connection = useMemo(() => connectionState(stored), [stored]);
  const [client, setClient] = useState<PragmaClient | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!stored) {
      setClient(null);
      return;
    }
    void (async () => {
      const next = await clientFor(stored.config);
      if (!cancelled) setClient(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [stored]);

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
    () =>
      connectionValue(
        status === "paired" && !client ? "loading" : status,
        connection.config,
        client,
        connection.hostName,
        pair,
        unpair,
        handleUnauthorized,
      ),
    [status, connection, client, pair, unpair, handleUnauthorized],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

function connectionState(stored: StoredState | null): {
  config: ConnectionConfig | null;
  hostName: string | null;
} {
  if (!stored) return { config: null, hostName: null };
  return { config: stored.config, hostName: stored.hostName };
}

function connectionValue(
  status: ConnectionStatus,
  config: ConnectionConfig | null,
  client: PragmaClient | null,
  hostName: string | null,
  pair: ConnectionContextValue["pair"],
  unpair: ConnectionContextValue["unpair"],
  handleUnauthorized: ConnectionContextValue["handleUnauthorized"],
): ConnectionContextValue {
  return { status, config, client, hostName, pair, unpair, handleUnauthorized };
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
    return isStoredState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStoredState(value: StoredState): boolean {
  return Boolean(value?.config?.url && value.config.token);
}

function useRestoredConnection(
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
): void {
  useEffect(() => {
    let cancelled = false;
    void restoreConnection(setStored, setStatus, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [setStatus, setStored]);
}

async function restoreConnection(
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const stored = await restoredState();
  if (isCancelled()) return;
  if (!stored) return setStatus("unpaired");
  const probe = await probeConnection(stored.config);
  if (isCancelled()) return;
  return applyRestoredProbe(probe, stored, setStored, setStatus);
}

async function restoredState(): Promise<StoredState | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY).catch(() => null);
  return raw ? (safeParse(raw) ?? devConfigFromEnv()) : devConfigFromEnv();
}

async function applyRestoredProbe(
  probe: ProbeResult,
  stored: StoredState,
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
): Promise<void> {
  if (probe.ok) {
    setStored(stored);
    return setStatus("paired");
  }
  await SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
  setStatus("unpaired");
}
