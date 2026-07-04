/**
 * Minimal semver handling for plugin API compatibility. Plugins stamp the
 * `@pragma/plugin` version they were compiled against (`__apiVersion`); the
 * host compares it with its own supported version before loading.
 */

/** A parsed `major.minor.patch` version. */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a `major.minor.patch` version string, ignoring any pre-release/build suffix. */
export function parseSemver(version: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** Outcome of comparing a plugin's compiled-against API version with the host's. */
export type PluginCompatibility =
  | { kind: "ok" }
  | { kind: "warn"; message: string }
  | { kind: "refuse"; message: string };

/**
 * Checks a plugin's `__apiVersion` against the host's `@pragma/plugin` version.
 *
 * - Different major → refuse (breaking API differences).
 * - Same major, plugin minor greater than host → load with a logged warning
 *   (the plugin may use APIs this host doesn't have yet).
 * - Otherwise → load.
 */
export function checkPluginCompatibility(
  pluginApiVersion: string,
  hostApiVersion: string,
): PluginCompatibility {
  const plugin = parseSemver(pluginApiVersion);
  const host = parseSemver(hostApiVersion);
  if (!plugin) {
    return {
      kind: "refuse",
      message: `plugin has an invalid @pragma/plugin API version "${pluginApiVersion}"`,
    };
  }
  if (!host) {
    return {
      kind: "refuse",
      message: `host has an invalid @pragma/plugin API version "${hostApiVersion}"`,
    };
  }
  if (plugin.major !== host.major) {
    return {
      kind: "refuse",
      message:
        `built against @pragma/plugin ${pluginApiVersion}, ` +
        `this Pragma supports ${host.major}.x`,
    };
  }
  if (plugin.minor > host.minor) {
    return {
      kind: "warn",
      message:
        `built against @pragma/plugin ${pluginApiVersion}, newer than this ` +
        `Pragma's ${hostApiVersion} — some APIs may be unavailable`,
    };
  }
  return { kind: "ok" };
}
