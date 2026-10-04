/**
 * Host-only helpers shared by the account modules. This package also runs in
 * the desktop webview, so nothing here may touch a Node built-in at import
 * time; every helper is only ever called on the host.
 */

interface HostProcess {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
}

/** The host's `process`, or undefined in the webview. */
export function hostProcess(): HostProcess | undefined {
  return (globalThis as { process?: HostProcess }).process;
}

/**
 * A Node built-in, reached through `process.getBuiltinModule` (Node 22.3+,
 * Bun) rather than an import. In the desktop webview a `node:` import — even
 * a lazy one the bundler keeps — has nothing to resolve to.
 */
export function hostBuiltin<T>(id: string): T {
  const load = hostProcess()?.getBuiltinModule;
  if (!load) throw new Error(`${id} is only available on the host`);
  return load(id) as T;
}

/** Expands a `~`-relative path against the host's home directory. */
export async function expandHome(path: string): Promise<string> {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const { homedir } = hostBuiltin<{ homedir: () => string }>("node:os");
  // Node and Bun accept `/` separators on Windows too.
  return `${homedir()}${path.slice(1)}`;
}

/** The value as a plain object, or undefined. */
export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
