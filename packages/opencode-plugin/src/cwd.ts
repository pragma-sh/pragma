import type { PluginContext } from "@pragma/plugin/catalog";

/**
 * Working directory for a shell-out that only needs *some* valid cwd.
 *
 * Deliberately node-free: this module is reachable from the plugin entry the
 * desktop webview imports through a blob URL, where a static `node:` import
 * fails to resolve and drops the whole plugin (its agents then disappear from
 * the launcher while the Bun sidecars keep working).
 */
export function pluginCwd(ctx: PluginContext): string {
  return ctx.project?.path ?? "/tmp";
}
