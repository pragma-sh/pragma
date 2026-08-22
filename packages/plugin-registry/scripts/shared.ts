import { resolve } from "node:path";

export const packageRoot = resolve(import.meta.dir, "..");

export interface PluginManifest {
  name: string;
  description: string;
  categories?: string[];
  images?: Array<{ url: string; alt: string }>;
  install: { command: string; args?: string[] };
  agentBinary?: string;
}

export interface LockEntry {
  package: string;
  version: string;
  tarball: string;
  integrity: string;
  manifestSha256: string;
  manifest: PluginManifest;
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

export function validateManifest(manifest: PluginManifest, context: string): void {
  if (!manifest.name?.trim() || !manifest.description?.trim()) {
    throw new Error(`${context}: name and description are required`);
  }
  if (!manifest.install?.command?.match(/^[A-Za-z0-9._+-]+$/)) {
    throw new Error(`${context}: install.command must be a bare executable name`);
  }
  if (
    manifest.categories?.some(
      (category) => !["agent-plugin", "theme", "general"].includes(category),
    )
  ) {
    throw new Error(`${context}: invalid category`);
  }
  if (manifest.images?.some((image) => !image.url.startsWith("https://") || !image.alt.trim())) {
    throw new Error(`${context}: images require HTTPS URLs and alt text`);
  }
  if (manifest.categories?.includes("agent-plugin") && !manifest.agentBinary) {
    throw new Error(`${context}: agent-plugin category requires agentBinary`);
  }
}

export function registryTarball(packageName: string, version: string): string {
  const unscoped = packageName.split("/").at(-1);
  return `https://registry.npmjs.org/${packageName}/-/${unscoped}-${version}.tgz`;
}

export function workspaceSource(packageName: string): string {
  return resolve(packageRoot, "..", packageName.split("/").at(-1) ?? packageName);
}
