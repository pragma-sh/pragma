import { discoverAcpSlashCommands, type AcpCommandSource } from "./acp-discovery";
import { dedupeSlashCommands, type AgentMode, type AgentSlashCommand } from "./agent";
import type { PluginContext } from "./types";

/**
 * A directory of markdown definitions an agent reads — custom slash commands,
 * skills, or agent profiles. Scanned on the host that owns the project, so a
 * remote project's files are found the same way as a local one's.
 */
export interface MarkdownSource {
  /** `~/`-prefixed for the home directory, otherwise relative to the project root. */
  dir: string;
  /**
   * `files`: every `*<suffix>` file, named by its path without the suffix with
   * `/` turned into `:` (Claude Code's namespaced commands). `skills`:
   * `<dir>/<name>/SKILL.md`, named by its frontmatter `name` or its directory.
   */
  layout: "files" | "skills";
  /** File suffix matched and stripped from `files` names. Defaults to `.md`. */
  suffix?: string;
  /** Descend into subdirectories for `files`. Defaults to `true`. */
  recursive?: boolean;
  /** Prefix added to every name, e.g. `prompts:` (Codex) or `skill:` (Pi). */
  prefix?: string;
  /** Prefer a `files` entry's frontmatter `name` over its path (agent profiles). */
  nameFromFrontmatter?: boolean;
}

/** One markdown definition found by {@link discoverMarkdownEntries}. */
export interface MarkdownEntry {
  name: string;
  /** Top-level scalar frontmatter keys (`description`, `argument-hint`, `mode`, …). */
  frontmatter: Record<string, string>;
  source: MarkdownSource;
}

const RECORD_SEPARATOR = "\u001e";
const HEAD_LINES = 40;
const MAX_DEPTH = 8;

/**
 * Lists markdown definitions under `sources` through the host's shell. Order
 * follows `sources`, so list higher-priority directories first and dedupe by
 * name. A missing directory contributes nothing; a host without a POSIX shell
 * returns an empty list instead of throwing.
 */
export async function discoverMarkdownEntries(
  ctx: PluginContext<unknown>,
  sources: MarkdownSource[],
): Promise<MarkdownEntry[]> {
  if (sources.length === 0) return [];
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [markdownScanScript(sources)],
  });
  if (!result || result.status !== 0) return [];
  return parseMarkdownScan(result.stdout, sources);
}

/**
 * Discovers user-invocable slash commands from command and skill directories.
 * Skills that set `user-invocable: false` are skipped. Earlier sources win.
 */
export async function discoverSlashCommands(
  ctx: PluginContext<unknown>,
  sources: MarkdownSource[],
): Promise<AgentSlashCommand[]> {
  return markdownSlashCommands(await discoverMarkdownEntries(ctx, sources));
}

/** Maps markdown entries to slash commands, first name wins. */
export function markdownSlashCommands(entries: MarkdownEntry[]): AgentSlashCommand[] {
  const seen = new Set<string>();
  const commands: AgentSlashCommand[] = [];
  for (const entry of entries) {
    if (entry.frontmatter["user-invocable"] === "false" || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const description = entry.frontmatter.description;
    const argumentHint = entry.frontmatter["argument-hint"];
    commands.push({
      name: entry.name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
    });
  }
  return commands;
}

/** Maps markdown agent profiles to modes, first name wins. */
export function markdownModes(entries: MarkdownEntry[]): AgentMode[] {
  const seen = new Set<string>();
  const modes: AgentMode[] = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const description = entry.frontmatter.description;
    modes.push({
      id: entry.name,
      name: titleCase(entry.name),
      ...(description ? { description } : {}),
    });
  }
  return modes;
}

/**
 * The common layout: `<root>/commands/**.md` custom commands and
 * `<root>/skills/<name>/SKILL.md` skills, for each root in priority order
 * (list the project root before the home one, e.g. `[".cursor", "~/.cursor"]`).
 */
export function commandAndSkillDirs(roots: string[]): MarkdownSource[] {
  return roots.flatMap((root) => [
    { dir: `${root}/commands`, layout: "files" as const },
    { dir: `${root}/skills`, layout: "skills" as const },
  ]);
}

const noCommands = (): AgentSlashCommand[] => [];

/** Extra places {@link slashCommandProvider} reads commands from. */
export interface SlashCommandDiscovery {
  /** The tool's ACP server: its own authoritative command and skill list. */
  acp?: AcpCommandSource;
  /** Any other tool-specific lookup (e.g. a CLI that prints its skills). */
  load?: (ctx: PluginContext<unknown>) => Promise<AgentSlashCommand[]>;
}

/**
 * A `slashCommands` provider: the tool's built-in commands, then its ACP list
 * and any custom lookup, then commands found under `sources`. The first entry
 * per name wins. Every discovery step degrades to nothing on failure, so the
 * picker is never empty for a tool that has built-ins.
 */
export function slashCommandProvider(
  builtins: AgentSlashCommand[],
  sources: MarkdownSource[],
  discovery: SlashCommandDiscovery = {},
): (ctx: PluginContext<unknown>) => Promise<AgentSlashCommand[]> {
  return async (ctx) => {
    const [acp, loaded, files] = await Promise.all([
      discovery.acp ? discoverAcpSlashCommands(ctx, discovery.acp).catch(noCommands) : [],
      discovery.load ? discovery.load(ctx).catch(noCommands) : [],
      discoverSlashCommands(ctx, sources).catch(noCommands),
    ]);
    return dedupeSlashCommands([...builtins, ...acp, ...loaded, ...files]);
  };
}

/**
 * A `modes` provider: `builtins` (the first is the tool's default) followed by
 * agent profiles discovered under `sources`, skipping any `keep` rejects.
 */
export function modeProvider(
  builtins: AgentMode[],
  sources: MarkdownSource[],
  keep: (entry: MarkdownEntry) => boolean = () => true,
): (ctx: PluginContext<unknown>) => Promise<AgentMode[]> {
  return async (ctx) => {
    const entries = await discoverMarkdownEntries(ctx, sources).catch(() => []);
    const discovered = markdownModes(entries.filter(keep));
    const ids = new Set(builtins.map((mode) => mode.id));
    return [...builtins, ...discovered.filter((mode) => !ids.has(mode.id))];
  };
}

/** Builds the POSIX shell script that prints each definition's path and head. */
function markdownScanScript(sources: MarkdownSource[]): string {
  const lines = [
    "pragma_scan() {",
    '  [ -d "$2" ] || return 0',
    '  find -L "$2" -maxdepth "$3" -type f -name "$4" 2>/dev/null | sort | while IFS= read -r f; do',
    `    printf '\\036%s\\t%s\\n' "$1" "\${f#"$2"/}"; head -n ${HEAD_LINES} "$f" 2>/dev/null; printf '\\n'`,
    "  done",
    "}",
  ];
  sources.forEach((source, index) => {
    const skills = source.layout === "skills";
    const depth = skills ? 2 : source.recursive === false ? 1 : MAX_DEPTH;
    const pattern = skills ? "SKILL.md" : `*${source.suffix ?? ".md"}`;
    lines.push(`pragma_scan ${index} ${shellDir(source.dir)} ${depth} ${shellQuote(pattern)}`);
  });
  lines.push("exit 0");
  return lines.join("\n");
}

/** Parses {@link markdownScanScript} output back into entries. */
function parseMarkdownScan(stdout: string, sources: MarkdownSource[]): MarkdownEntry[] {
  const entries: MarkdownEntry[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR).slice(1)) {
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const [indexText, relativePath] = header.split("\t");
    const source = sources[Number(indexText)];
    if (!source || !relativePath) continue;
    const frontmatter = parseFrontmatter(newline === -1 ? "" : record.slice(newline + 1));
    const name = entryName(source, relativePath, frontmatter);
    if (name) entries.push({ name: `${source.prefix ?? ""}${name}`, frontmatter, source });
  }
  return entries;
}

/** Reads top-level `key: value` scalars from a leading `---` frontmatter block. */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const result: Record<string, string> = {};
  // Key of an open `|`/`>` block scalar; its indented lines are folded into one value.
  let blockKey: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    if (blockKey && /^\s+\S/.test(line)) {
      const previous = result[blockKey];
      result[blockKey] = previous ? `${previous} ${line.trim()}` : line.trim();
      continue;
    }
    blockKey = null;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = unquote(match[2]!.trim());
    if (/^[|>][+-]?$/.test(value)) {
      blockKey = match[1]!;
    } else if (value) {
      result[match[1]!] = value;
    }
  }
  return result;
}

function entryName(
  source: MarkdownSource,
  relativePath: string,
  frontmatter: Record<string, string>,
): string | null {
  if (source.layout === "skills") {
    const directory = relativePath.split("/").slice(0, -1).join("/");
    return frontmatter.name ?? (directory || null);
  }
  if (source.nameFromFrontmatter && frontmatter.name) return frontmatter.name;
  const suffix = source.suffix ?? ".md";
  if (!relativePath.endsWith(suffix)) return null;
  return relativePath.slice(0, -suffix.length).split("/").join(":") || null;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function shellDir(dir: string): string {
  if (dir === "~") return '"$HOME"';
  if (dir.startsWith("~/")) return `"$HOME"/${shellQuote(dir.slice(2))}`;
  return shellQuote(dir);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
