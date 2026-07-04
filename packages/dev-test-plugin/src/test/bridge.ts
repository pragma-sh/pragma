import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";

import type { PragmaClient } from "@pragma/sdk";
import type { PragmaBridge, PragmaHooksBridge } from "@pragma/plugin";

type EventHandler = (payload: unknown) => void;
type StoredSetter<T> = (value: T | ((prev: T) => T)) => void;

/** Minimal shape of a `sdk.events.subscribe(...)` yielded event (test helper). */
export interface TestSubscriptionEvent {
  type: "snapshot" | "delta";
  subscription: string;
  payload: unknown;
}

/** Async generator yielding the given events, then completing (test helper). */
export async function* eventsFrom(
  ...events: TestSubscriptionEvent[]
): AsyncGenerator<TestSubscriptionEvent> {
  for (const event of events) {
    yield event;
  }
}

const EMPTY_SDK = {
  events: { subscribe: async function* (): AsyncGenerator<TestSubscriptionEvent> {} },
} as unknown as PragmaClient;

/** UI primitives captured once by `@pragma/plugin/ui` at module load. */
const Button = ({ variant: _variant, size: _size, ...rest }: Record<string, unknown>) =>
  React.createElement("button", rest);
const Kbd = (props: Record<string, unknown>) => React.createElement("kbd", props);

export interface BridgeHandle {
  bridge: PragmaBridge;
  /** Dispatches a host event captured by `useEvent(name, ...)`. */
  emit: (name: string, payload?: unknown) => void;
}

/** Builds a `__PRAGMA__` bridge, optionally overriding hook implementations. */
export function createBridge(hooks: Partial<PragmaHooksBridge> = {}): BridgeHandle {
  const handlers = new Map<string, EventHandler>();
  const stored = new Map<string, unknown>();

  const defaults = {
    usePluginConfig: () => ({}),
    useSdk: () => EMPTY_SDK,
    useProject: () => null,
    useTheme: () => "dark",
    useWebViewPayload: () => undefined,
    useNotify: () => () => undefined,
    useStoredState: <T>(key: string, initialValue: T) => {
      const value = (stored.has(key) ? stored.get(key) : initialValue) as T;
      const setter: StoredSetter<T> = (next) => {
        stored.set(key, next);
      };
      return [value, setter];
    },
    useSdkQuery: () => ({ data: undefined, error: null, loading: true, refetch: () => undefined }),
    useEvent: <TPayload>(name: string, handler: (payload: TPayload) => void): void => {
      handlers.set(name, handler as EventHandler);
    },
    useWorktreeChanges: () => ({
      data: undefined,
      error: null,
      loading: true,
      refetch: () => undefined,
    }),
    useBranchStatus: () => ({
      data: undefined,
      error: null,
      loading: true,
      refetch: () => undefined,
    }),
    useDirEntries: () => ({
      data: undefined,
      error: null,
      loading: true,
      refetch: () => undefined,
    }),
    useFileContents: () => ({
      data: undefined,
      error: null,
      loading: true,
      refetch: () => undefined,
    }),
    useAgentStatuses: () => ({
      data: undefined,
      error: null,
      loading: true,
      refetch: () => undefined,
    }),
    useSessions: () => ({ data: undefined, error: null, loading: true, refetch: () => undefined }),
  } as unknown as PragmaHooksBridge;

  const bridge: PragmaBridge = {
    react: React,
    reactDom: ReactDOM,
    jsxRuntime: jsxRuntime as unknown as PragmaBridge["jsxRuntime"],
    zod: {} as unknown as PragmaBridge["zod"],
    icons: {} as unknown as PragmaBridge["icons"],
    hooks: { ...defaults, ...hooks },
    actions: { openWebView: async () => undefined },
    ui: { Button, Kbd } as unknown as PragmaBridge["ui"],
  };

  return {
    bridge,
    emit: (name, payload) => handlers.get(name)?.(payload),
  };
}

const globalRef = globalThis as unknown as { __PRAGMA__?: PragmaBridge };

/** Installs a bridge onto `globalThis.__PRAGMA__`. */
export function setBridge(handle: BridgeHandle): void {
  globalRef.__PRAGMA__ = handle.bridge;
}

/** Clears `globalThis.__PRAGMA__`. */
export function clearBridge(): void {
  globalRef.__PRAGMA__ = undefined;
}
