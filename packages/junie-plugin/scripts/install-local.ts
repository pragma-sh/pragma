// Installs the Pragma status bridge into Junie's global configuration.
//
// Junie has exactly one hook-discovery mechanism: a `hooks` object in
// `~/.junie/config.json` (or a file passed with `--config-location`). A
// project-local `.junie/config.json` is ignored by default "for safety", so a
// per-checkout install would never fire — the global file is the only reliable
// target.
//
// `hooks/hooks.json` stays the single source of truth for the event map; this
// only rewrites `${JUNIE_PLUGIN_ROOT}` to this package's absolute path and
// merges the result into the existing config, preserving every key Junie or the
// user already owns. Entries are matched by their command containing this
// package's root, so re-running replaces the previous install instead of
// stacking duplicates. Because the installed commands point back at this
// checkout, edits to `hooks/report.sh` take effect on Junie's next session with
// no reinstall.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One command Junie runs for a hook event. */
interface JunieHookCommand {
  type: string;
  command: string;
  timeout?: number;
}

/** One matcher group inside a hook event's array. */
interface JunieHookEntry {
  matcher?: string;
  hooks: JunieHookCommand[];
}

/** Junie's global configuration file, of which only `hooks` is ours. */
interface JunieConfig {
  hooks?: Record<string, JunieHookEntry[]>;
  [key: string]: unknown;
}

/** Where Junie reads its global configuration from. */
const JUNIE_HOME = process.env.JUNIE_HOME ?? join(homedir(), ".junie");
const CONFIG_PATH = join(JUNIE_HOME, "config.json");
/**
 * Path fragment that identifies this package's hook script in an installed
 * command. The absolute plugin root changes per checkout (worktrees), so this
 * marker lets a reinstall from a different checkout replace the previous
 * install instead of stacking a second set of hooks.
 */
const HOOK_SCRIPT_MARKER = join("packages", "junie-plugin", "hooks", "report.sh");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(join(root, "hooks", "hooks.json"), "utf8");
const ours = (JSON.parse(template.replaceAll("${JUNIE_PLUGIN_ROOT}", root)) as JunieConfig).hooks;
if (ours === undefined) {
  throw new Error("hooks/hooks.json has no `hooks` object");
}

const existing = readConfig(CONFIG_PATH);
const installed: JunieConfig = { ...existing, hooks: mergeHooks(existing.hooks ?? {}, ours, root) };

mkdirSync(JUNIE_HOME, { recursive: true });
writeFileSync(CONFIG_PATH, `${JSON.stringify(installed, null, 2)}\n`);

process.stdout.write(`Installed the Pragma Junie hooks into ${CONFIG_PATH}\n`);
process.stdout.write(`They run \`${join(root, "hooks", "report.sh")}\`.\n`);
process.stdout.write("Start a new Junie session to load them.\n");

/** Reads Junie's config, treating a missing file as an empty one. */
function readConfig(path: string): JunieConfig {
  if (!existsSync(path)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainObject(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as JunieConfig;
}

/**
 * Merges this package's hook entries into the user's, dropping any entry a
 * previous install of *this* package left behind so the result is idempotent.
 * Hooks contributed by other tools are kept untouched.
 */
function mergeHooks(
  existingHooks: Record<string, JunieHookEntry[]>,
  ownHooks: Record<string, JunieHookEntry[]>,
  pluginRoot: string,
): Record<string, JunieHookEntry[]> {
  const merged = dropOwnEntries(existingHooks, pluginRoot);
  for (const [event, entries] of Object.entries(ownHooks)) {
    merged[event] = [...(merged[event] ?? []), ...entries];
  }
  return merged;
}

/** Keeps only hook entries that do not belong to this package. */
function dropOwnEntries(
  existingHooks: Record<string, JunieHookEntry[]>,
  pluginRoot: string,
): Record<string, JunieHookEntry[]> {
  const merged: Record<string, JunieHookEntry[]> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    const kept = entries.filter((entry) => !isOwnEntry(entry, pluginRoot));
    if (kept.length > 0) {
      merged[event] = kept;
    }
  }
  return merged;
}

/** True when every command in an entry comes from this package. */
function isOwnEntry(entry: JunieHookEntry, pluginRoot: string): boolean {
  return (entry.hooks ?? []).some((hook) => {
    const command = hook.command ?? "";
    // The absolute root changes per checkout (worktrees), so also match the
    // package's hook-script path: reinstalling from a different worktree must
    // replace the previous install instead of stacking a second set of hooks.
    return command.includes(pluginRoot) || command.includes(HOOK_SCRIPT_MARKER);
  });
}

/** Narrows an unknown to a plain object (not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
