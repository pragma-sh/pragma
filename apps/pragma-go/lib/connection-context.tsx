import { PragmaClient, PragmaGatewayError } from "@pragma-sh/sdk";
import Constants from "expo-constants";
import { router } from "expo-router";
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

import { streamingFetch } from "./gateway-fetch";
import { apiVersionProblem, type ConnectionConfig } from "./pairing";
import {
  flushPendingRevocations,
  forgetPendingRevocations,
  settleRevocation,
  unregisterFromPush,
} from "./push";
import { forgetHost, parseSavedHosts, rememberHost, type SavedHost } from "./saved-hosts";
import * as SecureStore from "./secret-store";
import { takeTokenFromUrl } from "./web-handoff";
import { constants } from "@pragma-sh/constants";

// App-wide owner of the single PragmaClient. The chat hook and the live data
// layer both consume the client from here, so pairing state lives in exactly
// one place. Config is persisted in the device keychain (expo-secure-store) and,
// for development only, falls back to EXPO_PUBLIC_PRAGMA_GATEWAY_* env until a
// device is paired for real.

const STORE_KEY = "pragma.connection.v1";
const DEVICE_ID_STORE_KEY = "pragma.device-id.v1";
const SAVED_HOSTS_STORE_KEY = "pragma.saved-hosts.v1";
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
  /**
   * Clears the stored config and returns to the unpaired experience at once;
   * the push revocation finishes (or is queued for retry) in the background.
   */
  unpair: () => Promise<void>;
  /** Handles a mid-session 401: clears state and routes to re-pair. */
  handleUnauthorized: () => void;
  /** Hosts this device has connected to before, most recent first. */
  savedHosts: SavedHost[];
  /** Removes a host from {@link ConnectionContextValue.savedHosts}. */
  forgetSavedHost: (url: string) => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

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
  const pending = buildGatewayHeaders();
  deviceHeadersPromise = pending.catch((error: unknown) => {
    deviceHeadersPromise = null;
    throw error;
  });
  return deviceHeadersPromise;
}

async function buildGatewayHeaders(): Promise<Record<string, string>> {
  const id = await deviceId();
  const headers = constants.gateway.deviceHeaders;
  return {
    "ngrok-skip-browser-warning": "true",
    [headers.id]: id,
    [headers.name]: deviceLabel(),
    [headers.platform]: Platform.OS,
    [headers.appVersion]: Constants.expoConfig?.version ?? "unknown",
  };
}

/** Human label this client shows up as in the desktop's device history. */
function deviceLabel(): string {
  if (Platform.OS === "ios") return "iPhone or iPad";
  if (Platform.OS === "android") return "Android device";
  return "Browser";
}

async function deviceId(): Promise<string> {
  const storedId = await SecureStore.getItemAsync(DEVICE_ID_STORE_KEY);
  if (storedId) return storedId;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(DEVICE_ID_STORE_KEY, id);
  return id;
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
 * Verifies a candidate config is reachable, speaks a `/v1` contract this build
 * understands, and has its token accepted. Distinguishes an unreachable host
 * from a rejected token so the pair screen can explain which.
 *
 * The version check lives here rather than only in the QR payload, because
 * every path that stores a connection comes through this probe: a scanned
 * code, a hand-typed URL, a `#t=` web handoff, and a host restored on launch
 * after the desktop upgraded underneath it.
 */
export async function probeConnection(config: ConnectionConfig): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const client = await clientFor(config);
    const health = await client.health.check({ signal: controller.signal });
    const problem = apiVersionProblem(health.apiVersion);
    if (problem !== null) return { ok: false, reason: problem };
    await client.agents.catalog({ signal: controller.signal });
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

  useFlushedRevocations();
  const { savedHosts, rememberSavedHost, forgetSavedHost } = useSavedHosts(stored);
  useRestoredConnection(setStored, setStatus, rememberSavedHost);

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
    // Pairing this host again supersedes a revocation queued for it, which
    // would otherwise unregister the token this session is about to register.
    // One still on the wire from a just-finished unpair is let settle first,
    // so its `DELETE` cannot land after this session's registration.
    await settleRevocation();
    await forgetPendingRevocations(config.url);
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
    setStored(next);
    setStatus("paired");
  }, []);

  const config = connection.config;
  const unpair = useCallback(async () => {
    // Tell the host to stop pushing, without waiting for it to answer: a host
    // that has gone away must not strand the user on a dead connection. The
    // revocation is saved before the credential is discarded (awaited here), so
    // an unanswered one is retried on the next launch instead of leaving the
    // token live on the host; only the request itself runs in the background.
    if (client && config) {
      await unregisterFromPush(client, config).catch((error: unknown) => {
        console.error("could not save the push revocation; the host may keep notifying", error);
      });
    }
    setStored(null);
    setStatus("unpaired");
    await SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
  }, [client, config]);

  const handleUnauthorized = useCallback(() => {
    // The host regenerated its token: drop everything and force a re-pair.
    void SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
    setStored(null);
    setStatus("unpaired");
    router.replace("/pair");
  }, []);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      status: status === "paired" && !client ? "loading" : status,
      config: connection.config,
      client,
      hostName: connection.hostName,
      pair,
      unpair,
      handleUnauthorized,
      savedHosts,
      forgetSavedHost,
    }),
    [status, connection, client, pair, unpair, handleUnauthorized, savedHosts, forgetSavedHost],
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

/**
 * Retries push revocations an earlier unpair could not deliver. Runs before the
 * user can pair again, so a host that was unreachable at unpair time stops
 * pushing to this phone as soon as it is reachable.
 */
function useFlushedRevocations(): void {
  useEffect(() => {
    flushPendingRevocations(clientFor).catch((error: unknown) => {
      console.error("could not retry pending push revocations", error);
    });
  }, []);
}

/**
 * The hosts the pair screen offers to reconnect to. Every connection that
 * becomes active — a fresh pairing or one restored on launch — is recorded,
 * so a host survives an unpair (or a launch that could not reach it) as a
 * one-tap reconnect rather than a fresh scan.
 */
function useSavedHosts(stored: StoredState | null): {
  savedHosts: SavedHost[];
  rememberSavedHost: (state: StoredState) => Promise<void>;
  forgetSavedHost: (url: string) => Promise<void>;
} {
  const [savedHosts, setSavedHosts] = useState<SavedHost[]>([]);

  const update = useCallback(async (change: (hosts: SavedHost[]) => SavedHost[]) => {
    setSavedHosts(await updateSavedHosts(change));
  }, []);

  useEffect(() => {
    readSavedHosts()
      .then(setSavedHosts)
      .catch((error: unknown) => console.error("could not read saved hosts", error));
  }, []);

  const rememberSavedHost = useCallback(
    (state: StoredState) =>
      update((hosts) => rememberHost(hosts, state.config, state.hostName, Date.now())),
    [update],
  );

  useEffect(() => {
    if (!stored) return;
    rememberSavedHost(stored).catch((error: unknown) =>
      console.error("could not remember this connection", error),
    );
  }, [stored, rememberSavedHost]);

  const forgetSavedHost = useCallback(
    (url: string) => update((hosts) => forgetHost(hosts, url)),
    [update],
  );

  return { savedHosts, rememberSavedHost, forgetSavedHost };
}

/** Tail of the saved-hosts write chain: each edit starts from the one before. */
let savedHostsWrites: Promise<void> = Promise.resolve();

/**
 * Applies `change` to the stored list and returns the result. Edits are
 * serialized, so overlapping removes or a remove during a reconnect cannot each
 * read the same old list and let the last write undo the others. A failed
 * write rejects instead of being reported as saved.
 */
async function updateSavedHosts(change: (hosts: SavedHost[]) => SavedHost[]): Promise<SavedHost[]> {
  const previous = savedHostsWrites;
  let release!: () => void;
  savedHostsWrites = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const next = change(await readSavedHosts());
    await SecureStore.setItemAsync(SAVED_HOSTS_STORE_KEY, JSON.stringify(next));
    return next;
  } finally {
    release();
  }
}

/** Reads the stored list. A storage error rejects rather than reading as empty. */
async function readSavedHosts(): Promise<SavedHost[]> {
  return parseSavedHosts(await SecureStore.getItemAsync(SAVED_HOSTS_STORE_KEY));
}

function useRestoredConnection(
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
  rememberSavedHost: (state: StoredState) => Promise<void>,
): void {
  useEffect(() => {
    let cancelled = false;
    void restoreConnection(setStored, setStatus, rememberSavedHost, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [setStatus, setStored, rememberSavedHost]);
}

async function restoreConnection(
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
  rememberSavedHost: (state: StoredState) => Promise<void>,
  isCancelled: () => boolean,
): Promise<void> {
  const handoff = takeTokenFromUrl();
  const stored = await candidateConnection(handoff);
  if (isCancelled()) return;
  if (!stored) return setStatus("unpaired");
  const probe = await probeConnection(stored.config);
  if (isCancelled()) return;
  return applyRestoredProbe(
    probe,
    stored,
    { persist: Boolean(handoff), remember: rememberSavedHost },
    setStored,
    setStatus,
  );
}

/**
 * The connection to try on launch. A `#t=` handoff in the page URL outranks
 * anything stored: the user just followed a fresh link from the desktop, which
 * is the newer intent.
 */
async function candidateConnection(handoff: ConnectionConfig | null): Promise<StoredState | null> {
  if (handoff) return { config: handoff, hostName: null };
  return restoredState();
}

async function restoredState(): Promise<StoredState | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY).catch(() => null);
  return raw ? (safeParse(raw) ?? devConfigFromEnv()) : devConfigFromEnv();
}

async function applyRestoredProbe(
  probe: ProbeResult,
  stored: StoredState,
  { persist, remember }: { persist: boolean; remember: (state: StoredState) => Promise<void> },
  setStored: (state: StoredState | null) => void,
  setStatus: (status: ConnectionStatus) => void,
): Promise<void> {
  if (probe.ok) {
    // A verified handoff has never been written down; store it so a reload
    // does not send the user back to pairing with no token left in the URL.
    if (persist) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(stored));
    setStored(stored);
    return setStatus("paired");
  }
  // A connection stored before saved hosts existed (or one the host could not
  // answer for now) is about to be discarded: keep it as a one-tap reconnect.
  // A handoff was never a connection this device held, so it is not kept.
  if (!persist) {
    await remember(stored).catch((error: unknown) =>
      console.error("could not keep the unreachable connection in history", error),
    );
  }
  await SecureStore.deleteItemAsync(STORE_KEY).catch(() => undefined);
  setStatus("unpaired");
}
