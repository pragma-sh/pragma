/** Environment variable names used by the gateway SDK. */
export const PRAGMA_ENV_KEYS = {
  gatewayUrl: "PRAGMA_GATEWAY_URL",
  gatewayToken: "PRAGMA_GATEWAY_TOKEN",
  tabId: "PRAGMA_TAB_ID",
  worktreeId: "PRAGMA_WORKTREE_ID",
} as const;

export type PragmaEnv = Record<string, string | undefined>;

/** Reads one env var from an injected env object or guarded `globalThis.process`. */
export function readEnv(name: string, env?: PragmaEnv): string | undefined {
  const globalProcess = (globalThis as { process?: { env?: PragmaEnv } }).process;
  return env?.[name] ?? globalProcess?.env?.[name];
}

/** Returns true when enough Pragma gateway/session env is present for agent reports. */
export function hasPragmaEnvironment(env?: PragmaEnv): boolean {
  return Boolean(
    readEnv(PRAGMA_ENV_KEYS.gatewayUrl, env) &&
    readEnv(PRAGMA_ENV_KEYS.gatewayToken, env) &&
    readEnv(PRAGMA_ENV_KEYS.tabId, env) &&
    readEnv(PRAGMA_ENV_KEYS.worktreeId, env),
  );
}
