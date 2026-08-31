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
  rejectInvalidManifest(
    !manifest.name?.trim() || !manifest.description?.trim(),
    context,
    "name and description are required",
  );
  rejectInvalidManifest(
    !manifest.install?.command?.match(/^[A-Za-z0-9._+-]+$/),
    context,
    "install.command must be a bare executable name",
  );
  rejectInvalidManifest(
    manifest.categories?.some(
      (category) => !["agent-plugin", "theme", "general"].includes(category),
    ),
    context,
    "invalid category",
  );
  rejectInvalidManifest(
    manifest.images?.some((image) => !image.url.startsWith("https://") || !image.alt.trim()),
    context,
    "images require HTTPS URLs and alt text",
  );
  rejectInvalidManifest(
    manifest.categories?.includes("agent-plugin") && !manifest.agentBinary,
    context,
    "agent-plugin category requires agentBinary",
  );
}

function rejectInvalidManifest(
  invalid: boolean | undefined,
  context: string,
  message: string,
): void {
  if (invalid) throw new Error(`${context}: ${message}`);
}

export function registryTarball(packageName: string, version: string): string {
  const unscoped = packageName.split("/").at(-1);
  return `https://registry.npmjs.org/${packageName}/-/${unscoped}-${version}.tgz`;
}

export function workspaceSource(packageName: string): string {
  return resolve(packageRoot, "..", packageName.split("/").at(-1) ?? packageName);
}
