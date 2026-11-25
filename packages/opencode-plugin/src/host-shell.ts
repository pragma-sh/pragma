import { pluginCwd, type HostContext } from "./cwd";

/**
 * `exec.run` interprets each command through the host's default shell:
 * PowerShell on Windows, a POSIX shell everywhere else. Neither quoting nor the
 * existence check is portable between the two.
 *
 * Resolved lazily, never at module scope: the desktop webview imports this
 * bundle to list launchable agents, and `process` does not exist there — a
 * module-scope read threw before any agent could be registered.
 */
function isWindowsHost(): boolean {
  return globalThis.process?.platform === "win32";
}

/** Exit status of {@link withOpenCode} when `opencode` is not installed. */
export const OPENCODE_MISSING_STATUS = 20;

/** Quotes one argument for the host shell. */
export function hostQuote(value: string): string {
  return isWindowsHost() ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Prefixes `command` with an `opencode` existence check that exits {@link OPENCODE_MISSING_STATUS}. */
export function withOpenCode(command: string): string {
  return isWindowsHost()
    ? `if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { exit ${OPENCODE_MISSING_STATUS} }; ${command}`
    : `command -v opencode >/dev/null 2>&1 || exit ${OPENCODE_MISSING_STATUS}; ${command}`;
}

/** Runs one host command from the plugin's working directory. */
export async function runOnHost(
  ctx: HostContext,
  command: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const [result] = await ctx.sdk.exec.run({ cwd: pluginCwd(ctx), commands: [command] });
  return result ?? { status: null, stdout: "", stderr: "" };
}
