import { pluginCwd, type HostContext } from "./cwd";
import { runOnHost } from "./host-shell";

/**
 * OpenCode v1 and v2 differ in everything Pragma drives outside the TUI: v2
 * keeps credentials in its database behind a background service, dropped
 * `opencode db`, and reads a different plugin API. Account and usage callbacks
 * ask which one is installed before they act.
 *
 * Cached briefly per working directory (one host each), so a burst of account
 * callbacks costs one `opencode --version`, while an upgrade is still noticed.
 */
const VERSION_TTL_MS = 60_000;
const versions = new Map<string, { major: number; checkedAt: number }>();
/**
 * Whether the OpenCode last probed is v2. The launch-argument builders are
 * synchronous and context-free, so they read the answer the catalog providers
 * (which run first, in the same process) already fetched. Unknown is v1: that
 * keeps the flags every v1 release accepts.
 */
let lastSeenV2 = false;

/** The major version in `opencode --version` output (`1.19.3`, `opencode v2.1.1`), or 0. */
function parseOpenCodeMajor(output: string): number {
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  return match ? Number(match[1]) : 0;
}

/** Whether the host's OpenCode is v2 or newer. A missing or unreadable `opencode` is v1. */
export async function isOpenCodeV2(ctx: HostContext): Promise<boolean> {
  const key = pluginCwd(ctx);
  const cached = versions.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < VERSION_TTL_MS) return cached.major >= 2;
  const result = await runOnHost(ctx, "opencode --version");
  const major = result.status === 0 ? parseOpenCodeMajor(result.stdout) : 0;
  versions.set(key, { major, checkedAt: now });
  // A failed probe says nothing about the version; keep the last real answer.
  if (result.status === 0) lastSeenV2 = major >= 2;
  return major >= 2;
}

/**
 * Whether `opencode` accepts `--model` and `--agent` when starting its TUI.
 *
 * v1 does. v2 dropped both from the top-level command (only `opencode mini`
 * and `opencode run` keep them) and exits with `Unrecognized flag` — so a
 * launch that passed one never started at all. On v2 the watcher applies the
 * selection through the TUI instead (`tui-selection.ts`).
 */
export function openCodeTakesSelectionFlags(): boolean {
  return !lastSeenV2;
}

/** Forgets cached versions. For tests. */
export function resetOpenCodeVersionCache(): void {
  versions.clear();
  lastSeenV2 = false;
}
