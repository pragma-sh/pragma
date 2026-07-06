import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineAutomation, type AutomationContext, type AutomationDefinition } from "./index.ts";

declare const Bun: {
  spawn(
    command: string[],
    options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
  ): {
    exited: Promise<number>;
    stderr: ReadableStream<Uint8Array>;
  };
};

type Scope = "global" | "local";

interface LoadCommand {
  type: "load";
  id: string;
  path: string;
  sourceVersion?: string;
  root: string;
  scope: Scope;
  projectId?: string | null;
  worktreeId?: string | null;
}

interface UnloadCommand {
  type: "unload" | "runNow" | "reload";
  id: string;
}

type Command = LoadCommand | UnloadCommand;

interface LoadedAutomation {
  command: LoadCommand;
  definition: AutomationDefinition;
  dispose?: () => void;
}

const loaded = new Map<string, LoadedAutomation>();
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitError(id: string | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: "error", id, error: message });
}

function cacheDir(): string {
  if (process.env.PRAGMA_AUTOMATIONS_CACHE) return process.env.PRAGMA_AUTOMATIONS_CACHE;
  const home = process.env.HOME ?? process.cwd();
  return join(home, ".pragma", "automation-cache");
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function bareImports(source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /export\s+[^"']+\s+from\s+["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (
        !specifier ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        builtins.has(specifier)
      ) {
        continue;
      }
      if (specifier === "@pragma/automations") continue;
      imports.add(packageName(specifier));
    }
  }
  return [...imports];
}

async function ensureRuntimePackage(root: string): Promise<void> {
  const pkgRoot = join(root, "node_modules", "@pragma", "automations");
  await mkdir(pkgRoot, { recursive: true });
  await writeFile(
    join(pkgRoot, "package.json"),
    JSON.stringify(
      { name: "@pragma/automations", type: "module", exports: { ".": "./index.ts" } },
      null,
      2,
    ),
  );
  await writeFile(
    join(pkgRoot, "index.ts"),
    `export { defineAutomation };\n${defineAutomation.toString()}\n`,
  );
}

async function ensurePackages(root: string, specifiers: string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await ensureRuntimePackage(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: {} }, null, 2),
  );
  const missing: string[] = [];
  const checks = await Promise.all(
    specifiers.map(async (specifier) => {
      try {
        await stat(join(root, "node_modules", specifier));
        return null;
      } catch {
        return specifier;
      }
    }),
  );
  missing.push(...checks.filter((specifier): specifier is string => specifier !== null));
  if (missing.length === 0) return;
  const proc = Bun.spawn(["bun", "add", ...missing], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`install failed for ${missing.join(", ")}: ${stderr.trim()}`);
  }
}

function validateAutomation(value: unknown): AutomationDefinition {
  if (!value || typeof value !== "object") throw new Error("default export is not an automation");
  const definition = value as AutomationDefinition;
  if (definition.pragmaAutomation !== true)
    throw new Error("default export must use defineAutomation");
  if (!definition.name.trim()) throw new Error("automation name is required");
  if (!definition.description.trim()) throw new Error("automation description is required");
  if (
    !definition.trigger ||
    (definition.trigger.type !== "cron" && definition.trigger.type !== "event")
  ) {
    throw new Error("automation trigger must be cron or event");
  }
  if (typeof definition.run !== "function") throw new Error("automation run must be a function");
  return definition;
}

async function copyEntry(command: LoadCommand, source: string, root: string): Promise<string> {
  const entryRoot = join(root, "entries", command.id, command.sourceVersion ?? "current");
  await mkdir(entryRoot, { recursive: true });
  const extension = command.path.endsWith(".js") ? "js" : "ts";
  const rewritten = source.replaceAll(
    "@pragma/automations",
    pathToFileURL(join(root, "node_modules", "@pragma", "automations", "index.ts")).href,
  );
  const entry = join(entryRoot, `automation.${extension}`);
  await writeFile(entry, rewritten);
  return entry;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function findFiles(
  root: string,
  start: string,
  options?: { name?: string; minBytes?: number },
): Promise<string[]> {
  const base = resolve(root, start);
  if (!within(root, base)) throw new Error("path escapes automation root");
  const result: string[] = [];
  async function walk(path: string): Promise<void> {
    // Missing or unreadable paths (ENOENT, EPERM, …) are skipped, not fatal —
    // a watcher polling for a file that does not exist yet must not throw.
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      let entries: string[];
      try {
        entries = await readdir(path);
      } catch {
        return;
      }
      await Promise.all(entries.map((entry) => walk(join(path, entry))));
      return;
    }
    if (options?.name !== undefined && basename(path) !== options.name) return;
    if (options?.minBytes === undefined || info.size >= options.minBytes) {
      result.push(relative(root, path));
    }
  }
  await walk(base);
  return result;
}

function contextFor(command: LoadCommand): AutomationContext {
  const log = (level: "info" | "warn" | "error") => (message: string, data?: unknown) => {
    emit({ type: "log", id: command.id, level, message, data });
  };
  return {
    log: {
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    paths: {
      project: command.root,
      worktree: command.root,
      global: command.scope === "global",
    },
    fs: {
      find: (path, options) => findFiles(command.root, path, options),
    },
    git: {},
  };
}

async function runAutomation(id: string, payload?: unknown): Promise<void> {
  const automation = loaded.get(id);
  if (!automation) throw new Error(`automation not loaded: ${id}`);
  const ctx = contextFor(automation.command);
  emit({ type: "status", id, status: "running" });
  try {
    await automation.definition.run(ctx, payload);
    emit({ type: "status", id, status: "idle" });
  } catch (error) {
    emitError(id, error);
  }
}

async function unload(id: string): Promise<void> {
  const automation = loaded.get(id);
  if (!automation) return;
  automation.dispose?.();
  loaded.delete(id);
  emit({ type: "unloaded", id });
}

async function load(command: LoadCommand): Promise<void> {
  await unload(command.id);
  const source = await readFile(command.path, "utf8");
  const root = cacheDir();
  await ensurePackages(root, bareImports(source));
  const entry = await copyEntry(command, source, root);
  const imported = (await import(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as {
    default?: unknown;
  };
  const definition = validateAutomation(imported.default);
  const loadedAutomation: LoadedAutomation = { command, definition };
  loaded.set(command.id, loadedAutomation);
  emit({
    type: "loaded",
    id: command.id,
    name: definition.name,
    description: definition.description,
    triggerKind: definition.trigger.type,
    schedule: definition.trigger.type === "cron" ? definition.trigger.schedule : null,
  });
  if (definition.trigger.type === "event") {
    const ctx = contextFor(command);
    const dispose = await definition.trigger.listen(ctx, (payload?: unknown) => {
      void runAutomation(command.id, payload);
    });
    if (typeof dispose === "function") loadedAutomation.dispose = dispose;
  }
  emit({ type: "status", id: command.id, status: "idle" });
}

async function handle(command: Command): Promise<void> {
  if (command.type === "load") {
    await load(command);
  } else if (command.type === "unload") {
    await unload(command.id);
  } else if (command.type === "reload") {
    const existing = loaded.get(command.id);
    if (!existing) throw new Error(`automation not loaded: ${command.id}`);
    await load(existing.command);
  } else {
    await runAutomation(command.id);
  }
}

class StdinLines {
  private buffer = "";

  constructor() {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        void this.dispatch(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private async dispatch(line: string): Promise<void> {
    let command: Command | undefined;
    try {
      command = JSON.parse(line) as Command;
      await handle(command);
    } catch (error) {
      emitError(command?.id, error);
    }
  }
}

// Automation callbacks (e.g. timers inside event listeners) can reject outside
// runAutomation's try/catch; report instead of letting the sidecar die.
process.on("unhandledRejection", (error) => emitError(undefined, error));
process.on("uncaughtException", (error) => emitError(undefined, error));

await mkdir(dirname(cacheDir()), { recursive: true });
const stdinLines = new StdinLines();
void stdinLines;
emit({ type: "ready" });
process.stdin.resume();
