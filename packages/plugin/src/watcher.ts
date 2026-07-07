import type { AgentMessage, PragmaClient } from "@pragma/sdk";

/** Declares a watcher a plugin attaches to one of its agents' sessions. */
export interface WatcherDefinition<TConfig = unknown> {
  /** The `defineAgent` id this watcher attaches to. */
  agent: string;
  /** Runs once per launched session; lives until the session exits. */
  watch: (ctx: WatcherContext<TConfig>) => void | Promise<void>;
}

/** Host-side context passed to a running watcher instance. */
export interface WatcherContext<TConfig = unknown> {
  /** Typed gateway SDK. */
  sdk: PragmaClient;
  /** Full agent id this watcher instance is bound to (plugin-qualified). */
  agentId: string;
  /** This plugin's validated config. */
  config: TConfig;
  /** Session this watcher is attached to. */
  session: { id: string; tabId: string; worktreeId: string };
  /** Decoded terminal output chunks for this session. */
  output: AsyncIterable<string>;
  /** Writes bytes into the live terminal session. */
  sendKeys: (data: string) => Promise<void>;
  /** Reports a rich message for this watcher-owned agent. */
  reportMessage: (msg: Omit<AgentMessage, "agent" | "tabId" | "worktreeId">) => Promise<void>;
  /** Aborts when the session exits or the watcher is stopped. */
  signal: AbortSignal;
}

/** Declares a watcher contribution. */
export function defineWatcher<TConfig = unknown>(
  input: WatcherDefinition<TConfig>,
): WatcherDefinition<TConfig> {
  return input;
}
