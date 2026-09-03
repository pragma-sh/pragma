import official from "../official.json";
import lock from "../official.lock.json";

/** Category used to group plugins in discovery surfaces. */
export type PluginCategory = "agent-plugin" | "theme" | "general";

/** Reviewed command run from installed npm package directory. */
export interface PluginInstallCommand {
  command: string;
  args?: string[];
}

/** Public metadata shipped by each npm plugin as `pragma-plugin.json`. */
export interface PragmaPluginManifest {
  name: string;
  description: string;
  /** Extended copy shown on the gallery detail page; falls back to `description`. */
  longDescription?: string;
  categories?: PluginCategory[];
  images?: Array<{ url: string; alt: string }>;
  install: PluginInstallCommand;
  agentBinary?: string;
}

/** One exact, integrity-pinned official plugin release. */
export interface LockedPlugin {
  package: string;
  version: string;
  tarball: string;
  integrity: string;
  manifestSha256: string;
  manifest: PragmaPluginManifest;
}

/** Human-reviewed official package list. */
export const officialPluginList = official;
/** Generated official release lock consumed by gallery and app. */
export const officialPluginLock = lock as { schemaVersion: 1; plugins: LockedPlugin[] };
