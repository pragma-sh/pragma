import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readStdinLines } from "@pragma/sidecar-kit";

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

const IMPORT_PATTERNS = [
  /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
  /export\s+[^"']+\s+from\s+["']([^"']+)["']/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
];

function isExternalSpecifier(specifier: string | undefined): specifier is string {
  if (!specifier || specifier === "@pragma/automations") return false;
  if (/^[./]/.test(specifier)) return false;
  return !builtins.has(specifier);
}

function bareImports(source: string): string[] {
  const imports = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (isExternalSpecifier(match[1])) imports.add(packageName(match[1]));
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

function hasValidTrigger(definition: AutomationDefinition): boolean {
  const trigger = definition.trigger;
  return Boolean(trigger) && (trigger.type === "cron" || trigger.type === "event");
}

/** Returns the first failing validation message for a definition, or null when valid. */
function automationProblem(definition: AutomationDefinition): string | null {
  const checks: Array<[boolean, string]> = [
    [definition.pragmaAutomation === true, "default export must use defineAutomation"],
    [Boolean(definition.name.trim()), "automation name is required"],
    [Boolean(definition.description.trim()), "automation description is required"],
    [hasValidTrigger(definition), "automation trigger must be cron or event"],
    [typeof definition.run === "function", "automation run must be a function"],
  ];
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

function validateAutomation(value: unknown): AutomationDefinition {
  if (!value || typeof value !== "object") throw new Error("default export is not an automation");
  const definition = value as AutomationDefinition;
  const problem = automationProblem(definition);
  if (problem) throw new Error(problem);
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

interface FindOptions {
  name?: string;
  minBytes?: number;
}

// Missing or unreadable paths (ENOENT, EPERM, …) are skipped, not fatal —
// a watcher polling for a file that does not exist yet must not throw.
async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function fileMatches(path: string, size: number | bigint, options: FindOptions): boolean {
  if (options.name !== undefined && basename(path) !== options.name) return false;
  return options.minBytes === undefined || size >= options.minBytes;
}

async function findFiles(
  root: string,
  start: string,
  options: FindOptions = {},
): Promise<string[]> {
  const base = resolve(root, start);
  if (!within(root, base)) throw new Error("path escapes automation root");
  const result: string[] = [];
  async function walk(path: string): Promise<void> {
    const info = await statSafe(path);
    if (!info) return;
    if (info.isDirectory()) {
      const entries = await readdirSafe(path);
      await Promise.all(entries.map((entry) => walk(join(path, entry))));
      return;
    }
    if (fileMatches(path, info.size, options)) result.push(relative(root, path));
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

async function reload(id: string): Promise<void> {
  const existing = loaded.get(id);
  if (!existing) throw new Error(`automation not loaded: ${id}`);
  await load(existing.command);
}

async function handle(command: Command): Promise<void> {
  switch (command.type) {
    case "load":
      return load(command);
    case "unload":
      return unload(command.id);
    case "reload":
      return reload(command.id);
    default:
      return runAutomation(command.id);
  }
}

class StdinLines {
  constructor() {
    readStdinLines((line) => void this.dispatch(line));
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
