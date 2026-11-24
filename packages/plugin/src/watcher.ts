import type { AgentMessage, PragmaClient } from "@pragma-sh/sdk";

import type { AgentLaunchSelection } from "./agent";

/** Declares a watcher a plugin attaches to one of its agents' sessions. */
export interface WatcherDefinition<TConfig = unknown> {
  /** The `defineAgent` id this watcher attaches to. */
  agent: string;
  /** Runs once per launched session; lives until the session exits. */
  watch: (ctx: WatcherContext<TConfig>) => void | Promise<void>;
  /**
   * Keys the host writes into the terminal to cancel the agent's running turn
   * when a client interrupts it (a phone's Stop button). Defaults to Escape;
   * set it for a TUI that cancels on something else — Grok binds Escape to
   * scrollback and cancels on Ctrl+C (`"\x03"`).
   */
  interruptKeys?: string;
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
  /**
   * The choices the launch that started this session made, for a harness that
   * takes them through its TUI because it has no launch flag for them.
   *
   * Present only on a watcher the host started together with a fresh launch,
   * while the harness is still on its start screen. A watcher started later
   * (the first one died, the gateway restarted, the session was resumed, the
   * agent was typed by hand) gets none, so applying it can never type into a
   * running turn. Prefer `AgentArgsBuilder` flags whenever the harness has them.
   */
  selection?: AgentLaunchSelection;
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
