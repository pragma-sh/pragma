import type { PragmaClient } from "@pragma/sdk";

/** The active project a plugin is rendered against, or `null` when none is selected. */
export interface PluginProject {
  id: string;
  name: string;
  path: string;
}

/** Options for {@link PluginContext.notify} / `useNotify()`. */
export interface PluginNotifyOptions {
  variant?: "info" | "success" | "warning" | "error";
  description?: string;
  /** Also send a native OS notification through Pragma's notification bridge. */
  native?: boolean;
}

/**
 * Context passed to every plugin callback: contribution `when` guards, command
 * `run` handlers, agent event handlers, and `activate`.
 */
export interface PluginContext<TConfig = unknown> {
  /** This plugin's stable id, derived from its `package.json` name. */
  pluginId: string;
  /** Absolute plugin package directory when available in this runtime. */
  pluginDir?: string;
  /** This plugin's user-supplied config, already validated against its `config` schema. */
  config: TConfig;
  /** The active project, or `null` when no project is selected. */
  project: PluginProject | null;
  /** Typed SDK client for talking to the local Pragma gateway. */
  sdk: PragmaClient;
  /** Shows an in-app notification. */
  notify: (message: string, options?: PluginNotifyOptions) => void;
}

/** Result shape shared by every `useSdkQuery`-style hook. */
export interface PluginQueryResult<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/** One agent's live status, as surfaced by `useAgentStatuses`. */
export interface PluginAgentStatusEntry {
  agent: string;
  status: "running" | "attention" | "done";
}

/**
 * Minimal live-session summary surfaced by `useSessions`. `@pragma/sdk` does
 * not yet expose a dedicated session-list RPC, so this is intentionally small
 * — expect it to grow once that endpoint exists.
 */
export interface PluginSessionSummary {
  id: string;
  cwd: string;
}

/** Payload emitted for `pragma://plugin/<pluginId>/<path>` deep links. */
export interface PluginDeepLinkEvent {
  pluginId: string;
  path: string;
  url: string;
  params: Record<string, string[]>;
}
