import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import type {
  PluginAgentStatusEntry,
  PluginNotifyOptions,
  PluginProject,
  PluginQueryResult,
  PluginSessionSummary,
  PragmaHooksBridge,
} from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import { useRequiredContext } from "@/lib/context";
import { errorMessage } from "@/lib/errors";
import { pluginStorageGet, pluginStorageSet } from "@/lib/tauri";
import { agentEntriesForWorktree, subscribeAgentStatuses } from "@/state/agent-status-store";
import { subscribePluginEvent } from "./events";

/**
 * Host-side implementations behind `__PRAGMA__.hooks`. Plugin components call
 * the delegator hooks exported by `@pragma/plugin`; those land here, where the
 * host owns the real React state, SDK client, and stores.
 */

// ---------------------------------------------------------------------------
// Runtime state shared with PluginProvider
// ---------------------------------------------------------------------------

interface PluginRuntimeState {
  sdk: PragmaClient | null;
  project: PluginProject | null;
}

let runtimeState: PluginRuntimeState = { sdk: null, project: null };
const runtimeListeners = new Set<() => void>();

function emitRuntime(): void {
  for (const listener of runtimeListeners) {
    listener();
  }
}

function subscribeRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

function getRuntimeState(): PluginRuntimeState {
  return runtimeState;
}

/** React hook for host code that needs the current plugin runtime services. */
export function usePluginRuntimeState(): PluginRuntimeState {
  return useSyncExternalStore(subscribeRuntime, getRuntimeState, getRuntimeState);
}

/** Publishes the SDK client for `useSdk`/`useSdkQuery` (set by PluginProvider). */
export function setPluginRuntimeSdk(sdk: PragmaClient | null): void {
  runtimeState = { ...runtimeState, sdk };
  emitRuntime();
}

/** Publishes the active project for `useProject` (set by PluginProvider). */
export function setPluginRuntimeProject(project: PluginProject | null): void {
  runtimeState = { ...runtimeState, project };
  emitRuntime();
}

// ---------------------------------------------------------------------------
// Per-plugin render boundary
// ---------------------------------------------------------------------------

interface PluginBoundaryValue {
  pluginId: string;
  config: unknown;
  webViewPayload?: unknown;
}

const PluginBoundaryContext = createContext<PluginBoundaryValue | null>(null);

/**
 * Wraps a plugin-contributed component subtree so per-plugin hooks
 * (`usePluginConfig`, `useStoredState`) know which plugin is rendering.
 */
export function PluginBoundary(props: {
  pluginId: string;
  config: unknown;
  webViewPayload?: unknown;
  children: ReactNode;
}): ReactNode {
  const value = useMemo(
    () => ({
      pluginId: props.pluginId,
      config: props.config,
      webViewPayload: props.webViewPayload,
    }),
    [props.pluginId, props.config, props.webViewPayload],
  );
  return (
    <PluginBoundaryContext.Provider value={value}>{props.children}</PluginBoundaryContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook implementations
// ---------------------------------------------------------------------------

function usePluginConfigImpl<TConfig>(): TConfig {
  const boundary = useRequiredContext(PluginBoundaryContext, "usePluginConfig");
  return boundary.config as TConfig;
}

function useSdkImpl(): PragmaClient {
  const state = usePluginRuntimeState();
  if (!state.sdk) {
    throw new Error("Pragma SDK is not connected yet — the local gateway has not come up");
  }
  return state.sdk;
}

function useProjectImpl(): PluginProject | null {
  return usePluginRuntimeState().project;
}

const darkQuery = "(prefers-color-scheme: dark)";

function subscribeTheme(listener: () => void): () => void {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
}

function getTheme(): "light" | "dark" {
  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

function useThemeImpl(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, getTheme, () => "light" as const);
}

function useWebViewPayloadImpl<TPayload>(): TPayload | undefined {
  const boundary = useRequiredContext(PluginBoundaryContext, "useWebViewPayload");
  return boundary.webViewPayload as TPayload | undefined;
}

function useNotifyImpl(): (message: string, options?: PluginNotifyOptions) => void {
  return useCallback((message: string, options?: PluginNotifyOptions) => {
    notifyFromPlugin(message, options);
  }, []);
}

/** Shows a plugin-originated notification (also used for `PluginContext.notify`). */
export function notifyFromPlugin(message: string, options?: PluginNotifyOptions): void {
  const variant = options?.variant ?? "info";
  const description = options?.description;
  switch (variant) {
    case "success":
      toast.success(message, { description });
      break;
    case "warning":
      toast.warning(message, { description });
      break;
    case "error":
      toast.error(message, { description });
      break;
    default:
      toast.info(message, { description });
  }
  if (options?.native === true) {
    void notifyNative(message, description);
  }
}

async function notifyNative(message: string, description: string | undefined): Promise<void> {
  const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (granted) {
    sendNotification({ title: message, body: description });
  }
}

function useStoredStateImpl<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const boundary = useRequiredContext(PluginBoundaryContext, "useStoredState");
  const [value, setValue] = useState<T>(initialValue);
  useEffect(() => {
    let cancelled = false;
    void pluginStorageGet(boundary.pluginId, key)
      .then((raw) => {
        if (!cancelled && raw !== null) {
          setValue(JSON.parse(raw) as T);
        }
        return undefined;
      })
      .catch((cause: unknown) => {
        console.warn(`plugin storage read failed for ${boundary.pluginId}:${key}`, cause);
      });
    return () => {
      cancelled = true;
    };
  }, [boundary.pluginId, key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        void pluginStorageSet(boundary.pluginId, key, JSON.stringify(resolved)).catch(
          (cause: unknown) => {
            console.warn(`plugin storage write failed for ${boundary.pluginId}:${key}`, cause);
          },
        );
        return resolved;
      });
    },
    [boundary.pluginId, key],
  );
  return [value, set];
}

function useSdkQueryImpl<T>(
  queryFn: (sdk: PragmaClient) => Promise<T>,
  deps: readonly unknown[],
): PluginQueryResult<T> {
  const sdk = useSdkImpl();
  const queryRef = useRef(queryFn);
  queryRef.current = queryFn;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    data: T | undefined;
    error: string | null;
    loading: boolean;
  }>({ data: undefined, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    queryRef
      .current(sdk)
      .then((data) => {
        if (!cancelled) {
          setState({ data, error: null, loading: false });
        }
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ data: undefined, error: errorMessage(cause), loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
    // The caller-supplied deps array intentionally drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, nonce, ...deps]);
  const refetch = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);
  return { ...state, refetch };
}

function useEventImpl<TPayload>(eventName: string, handler: (payload: TPayload) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(
    () =>
      subscribePluginEvent(eventName, (payload) => {
        handlerRef.current(payload as TPayload);
      }),
    [eventName],
  );
}

function useAgentStatusesImpl(
  worktreeId: string | null,
): PluginQueryResult<PluginAgentStatusEntry[]> {
  const [entries, setEntries] = useState<PluginAgentStatusEntry[]>(() =>
    pluginAgentEntries(worktreeId),
  );
  useEffect(() => {
    setEntries(pluginAgentEntries(worktreeId));
    return subscribeAgentStatuses(() => {
      setEntries(pluginAgentEntries(worktreeId));
    });
  }, [worktreeId]);
  const refetch = useCallback(() => {
    setEntries(pluginAgentEntries(worktreeId));
  }, [worktreeId]);
  return { data: entries, error: null, loading: false, refetch };
}

function pluginAgentEntries(worktreeId: string | null): PluginAgentStatusEntry[] {
  const entries: PluginAgentStatusEntry[] = [];
  for (const entry of agentEntriesForWorktree(worktreeId)) {
    if (entry.status !== "cleared") {
      entries.push({ agent: entry.agent, status: entry.status });
    }
  }
  return entries;
}

const noSessions: PluginSessionSummary[] = [];

function useSessionsImpl(): PluginQueryResult<PluginSessionSummary[]> {
  // `@pragma/sdk` has no session-list RPC yet; this returns an empty list so
  // the hook's shape is stable. Expect real data once that endpoint exists.
  const refetch = useCallback(() => {}, []);
  return { data: noSessions, error: null, loading: false, refetch };
}

/** The complete hooks object installed at `__PRAGMA__.hooks`. */
export const hostHooks: PragmaHooksBridge = {
  usePluginConfig: usePluginConfigImpl,
  useSdk: useSdkImpl,
  useProject: useProjectImpl,
  useTheme: useThemeImpl,
  useWebViewPayload: useWebViewPayloadImpl,
  useNotify: useNotifyImpl,
  useStoredState: useStoredStateImpl,
  useSdkQuery: useSdkQueryImpl,
  useEvent: useEventImpl,
  useWorktreeChanges: (worktreeRoot) =>
    useSdkQueryImpl(
      (sdk) => {
        if (worktreeRoot === null) {
          return Promise.reject(new Error("no worktree selected"));
        }
        return sdk.git.worktreeChanges({ root: worktreeRoot });
      },
      [worktreeRoot],
    ),
  useBranchStatus: (worktreeRoot) =>
    useSdkQueryImpl(
      (sdk) => {
        if (worktreeRoot === null) {
          return Promise.reject(new Error("no worktree selected"));
        }
        return sdk.git.githubFetchAndSync({ root: worktreeRoot });
      },
      [worktreeRoot],
    ),
  useDirEntries: (root, path = ".") =>
    useSdkQueryImpl(
      (sdk) => {
        if (root === null) {
          return Promise.reject(new Error("no root path given"));
        }
        return sdk.fs.listDir({ root, path });
      },
      [root, path],
    ),
  useFileContents: (root, path) =>
    useSdkQueryImpl(
      (sdk) => {
        if (root === null || path === null) {
          return Promise.reject(new Error("no file path given"));
        }
        return sdk.fs.readFile({ root, path });
      },
      [root, path],
    ),
  useAgentStatuses: useAgentStatusesImpl,
  useSessions: useSessionsImpl,
};
