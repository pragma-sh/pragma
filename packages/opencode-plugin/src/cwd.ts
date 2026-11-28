import type { PluginContext } from "@pragma-sh/plugin/catalog";

/**
 * What a host shell-out needs: the gateway SDK and, when there is one, the
 * active project. A catalog callback passes its whole context; a watcher,
 * which has no project, passes just its SDK.
 */
export type HostContext = Pick<PluginContext, "sdk"> & { project?: PluginContext["project"] };

/**
 * Working directory for a shell-out that only needs *some* valid cwd.
 *
 * Deliberately node-free: this module is reachable from the plugin entry the
 * desktop webview imports through a blob URL, where a static `node:` import
 * fails to resolve and drops the whole plugin (its agents then disappear from
 * the launcher while the Bun sidecars keep working).
 */
export function pluginCwd(ctx: HostContext): string {
  return ctx.project?.path ?? "/tmp";
}
