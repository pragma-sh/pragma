import type {
  AgentMessage,
  BranchSyncStatus,
  DirEntry,
  FileContents,
  PragmaClient,
  WorktreeChanges,
} from "@pragma/sdk";
import { getBridge } from "./bridge";
import type {
  PluginAgentStatusEntry,
  PluginNotifyOptions,
  PluginProject,
  PluginQueryResult,
  PluginSessionSummary,
} from "./types";

/**
 * The hook implementations the Pragma host installs at `__PRAGMA__.hooks`.
 * Every plugin-facing hook below is a thin delegator onto this object — the
 * host owns the real React state/effects; `@pragma/plugin` only declares the
 * shape so plugin authors get full typing.
 */
export interface PragmaHooksBridge {
  usePluginConfig: <TConfig>() => TConfig;
  useSdk: () => PragmaClient;
  useProject: () => PluginProject | null;
  useTheme: () => "light" | "dark";
  useWebViewPayload: <T>() => T | undefined;
  useNotify: () => (message: string, options?: PluginNotifyOptions) => void;
  useStoredState: <T>(key: string, initialValue: T) => [T, (value: T | ((prev: T) => T)) => void];
  useSdkQuery: <T>(
    queryFn: (sdk: PragmaClient) => Promise<T>,
    deps: readonly unknown[],
  ) => PluginQueryResult<T>;
  useEvent: <TPayload>(eventName: string, handler: (payload: TPayload) => void) => void;
  useWorktreeChanges: (worktreeRoot: string | null) => PluginQueryResult<WorktreeChanges>;
  useBranchStatus: (worktreeRoot: string | null) => PluginQueryResult<BranchSyncStatus>;
  useDirEntries: (root: string | null, path?: string) => PluginQueryResult<DirEntry[]>;
  useFileContents: (root: string | null, path: string | null) => PluginQueryResult<FileContents>;
  useAgentStatuses: (worktreeId: string | null) => PluginQueryResult<PluginAgentStatusEntry[]>;
  useAgentMessages: (
    worktreeId: string | null,
    tabId?: string | null,
  ) => PluginQueryResult<AgentMessage[]>;
  useSessions: () => PluginQueryResult<PluginSessionSummary[]>;
}

/** This plugin's config, already validated against its `config` schema. */
export function usePluginConfig<TConfig = unknown>(): TConfig {
  return getBridge().hooks.usePluginConfig<TConfig>();
}

/** Typed SDK client for talking to the local Pragma gateway. */
export function useSdk(): PragmaClient {
  return getBridge().hooks.useSdk();
}

/** The active project, or `null` when no project is selected. */
export function useProject(): PluginProject | null {
  return getBridge().hooks.useProject();
}

/** The host's current color theme. */
export function useTheme(): "light" | "dark" {
  return getBridge().hooks.useTheme();
}

/** Payload supplied when the current plugin web view tab was opened. */
export function useWebViewPayload<TPayload = unknown>(): TPayload | undefined {
  return getBridge().hooks.useWebViewPayload<TPayload>();
}

/** Returns a function that shows an in-app notification. */
export function useNotify(): (message: string, options?: PluginNotifyOptions) => void {
  return getBridge().hooks.useNotify();
}

/** State persisted across app restarts, scoped to this plugin. */
export function useStoredState<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  return getBridge().hooks.useStoredState(key, initialValue);
}

/** Runs an arbitrary SDK query, re-running when `deps` change. */
export function useSdkQuery<T>(
  queryFn: (sdk: PragmaClient) => Promise<T>,
  deps: readonly unknown[],
): PluginQueryResult<T> {
  return getBridge().hooks.useSdkQuery(queryFn, deps);
}

/** Subscribes to a named host event (e.g. `"agent.report"`) for this plugin's lifetime. */
export function useEvent<TPayload = unknown>(
  eventName: string,
  handler: (payload: TPayload) => void,
): void {
  getBridge().hooks.useEvent(eventName, handler);
}

/** Uncommitted + committed diff summary for a worktree root. */
export function useWorktreeChanges(
  worktreeRoot: string | null,
): PluginQueryResult<WorktreeChanges> {
  return getBridge().hooks.useWorktreeChanges(worktreeRoot);
}

/** Ahead/behind sync status against the branch's upstream. */
export function useBranchStatus(worktreeRoot: string | null): PluginQueryResult<BranchSyncStatus> {
  return getBridge().hooks.useBranchStatus(worktreeRoot);
}

/** Directory listing for a worktree-relative path (defaults to the root itself). */
export function useDirEntries(root: string | null, path = "."): PluginQueryResult<DirEntry[]> {
  return getBridge().hooks.useDirEntries(root, path);
}

/** File contents for a worktree-relative path. */
export function useFileContents(
  root: string | null,
  path: string | null,
): PluginQueryResult<FileContents> {
  return getBridge().hooks.useFileContents(root, path);
}

/** Live agent statuses for a worktree. */
export function useAgentStatuses(
  worktreeId: string | null,
): PluginQueryResult<PluginAgentStatusEntry[]> {
  return getBridge().hooks.useAgentStatuses(worktreeId);
}

/** Live rich agent messages for a worktree, optionally scoped to one tab. */
export function useAgentMessages(
  worktreeId: string | null,
  tabId?: string | null,
): PluginQueryResult<AgentMessage[]> {
  return getBridge().hooks.useAgentMessages(worktreeId, tabId);
}

/** Live PTY sessions. */
export function useSessions(): PluginQueryResult<PluginSessionSummary[]> {
  return getBridge().hooks.useSessions();
}
