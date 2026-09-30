/**
 * `automode.md` — the user's own rules for auto mode.
 *
 * The file lives at `~/.pragma/automode.md` (global) and
 * `<project>/.pragma/automode.md` (project). Its YAML frontmatter holds hard
 * filters that are enforced **in code** before a System 1 model ever sees the
 * candidates; its markdown body is free text handed to the model as the user's
 * priorities.
 *
 * ```md
 * ---
 * agents:
 *   include: [claude-code, codex]
 *   exclude: [cursor]
 * models:
 *   include: ["codex/gpt-6*"]
 *   exclude: ["*haiku*"]
 * priority: accuracy
 * ---
 * Use Codex for quick scripted fixes. Use Claude Code + Opus for refactors.
 * ```
 *
 * Patterns are case-insensitive globs where `*` matches any run of characters.
 * A model pattern is either `model` (any agent) or `agent/model` (only that
 * agent). A model `include` list restricts only the agents it names, so
 * `include: ["codex/gpt-6*"]` narrows Codex without emptying every other agent.
 */
import { parse as parseYaml } from "yaml";

/** What the user wants auto mode to weigh most when nothing else decides. */
export type AutoModePriority = "accuracy" | "speed" | "efficiency" | "balanced";

const PRIORITIES: readonly AutoModePriority[] = ["accuracy", "speed", "efficiency", "balanced"];

/** Include/exclude glob lists. An empty `include` means "no restriction". */
export interface AutoModeFilter {
  include: string[];
  exclude: string[];
}

/** One parsed `automode.md`. */
export interface AutoModePreferences {
  agents: AutoModeFilter;
  models: AutoModeFilter;
  priority: AutoModePriority | null;
  /** The markdown body, trimmed. */
  notes: string;
}

/** Global and project preferences merged, with each scope's notes kept apart. */
export interface MergedAutoModePreferences {
  agents: AutoModeFilter;
  models: AutoModeFilter;
  priority: AutoModePriority | null;
  notes: { project: string; global: string };
}

/** A parse result: the preferences plus anything the user should fix. */
export interface ParsedAutoMode {
  preferences: AutoModePreferences;
  warnings: string[];
}

/** An agent and its models as auto mode sees them. */
export interface AutoModeCandidate<M extends { id: string } = { id: string }> {
  id: string;
  models: M[];
}

/** No preferences at all — what a missing file means. */
export const EMPTY_AUTO_MODE: AutoModePreferences = {
  agents: { include: [], exclude: [] },
  models: { include: [], exclude: [] },
  priority: null,
  notes: "",
};

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_KEYS = new Set(["agents", "models", "priority"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a string list, accepting a lone string as a one-item list. */
function stringList(value: unknown, name: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else warnings.push(`${name} entries must be non-empty strings`);
  }
  return out;
}

/**
 * Reads `agents:` / `models:`. A bare list is shorthand for `include`, which is
 * what most people mean when they write `agents: [codex]`.
 */
function parseFilter(value: unknown, name: string, warnings: string[]): AutoModeFilter {
  if (value === undefined || value === null) return { include: [], exclude: [] };
  if (Array.isArray(value) || typeof value === "string") {
    return { include: stringList(value, `${name}`, warnings), exclude: [] };
  }
  if (!isRecord(value)) {
    warnings.push(`${name} must be a list or an object with include/exclude`);
    return { include: [], exclude: [] };
  }
  for (const key of Object.keys(value)) {
    if (key !== "include" && key !== "exclude") warnings.push(`unknown key ${name}.${key}`);
  }
  return {
    include: stringList(value.include, `${name}.include`, warnings),
    exclude: stringList(value.exclude, `${name}.exclude`, warnings),
  };
}

function parsePriority(value: unknown, warnings: string[]): AutoModePriority | null {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((PRIORITIES as readonly string[]).includes(normalized)) {
    return normalized as AutoModePriority;
  }
  warnings.push(`priority must be one of ${PRIORITIES.join(", ")}`);
  return null;
}

function parseFrontmatter(yaml: string, warnings: string[]): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (cause) {
    warnings.push(
      `frontmatter is not valid YAML: ${cause instanceof Error ? cause.message : cause}`,
    );
    return {};
  }
  if (data === null || data === undefined) return {};
  if (!isRecord(data)) {
    warnings.push("frontmatter must be a YAML mapping");
    return {};
  }
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown frontmatter key "${key}"`);
  }
  return data;
}

/**
 * Parses one `automode.md`. Never throws: a malformed frontmatter yields empty
 * filters plus a warning, and the body still reaches the model — a typo in the
 * YAML should not silently discard the user's prose.
 */
export function parseAutoMode(source: string | null | undefined): ParsedAutoMode {
  if (!source?.trim()) return { preferences: EMPTY_AUTO_MODE, warnings: [] };
  const warnings: string[] = [];
  const match = FRONTMATTER.exec(source);
  const data = match ? parseFrontmatter(match[1] ?? "", warnings) : {};
  const body = match ? source.slice(match[0].length) : source;
  return {
    preferences: {
      agents: parseFilter(data.agents, "agents", warnings),
      models: parseFilter(data.models, "models", warnings),
      priority: parsePriority(data.priority, warnings),
      notes: body.trim(),
    },
    warnings,
  };
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Merges the two scopes; the project wins. Excludes are unioned (either scope
 * can rule something out), a non-empty project `include` replaces the global
 * one, and the project `priority` overrides the global one.
 */
export function mergeAutoMode(
  global: AutoModePreferences,
  project: AutoModePreferences,
): MergedAutoModePreferences {
  const merge = (g: AutoModeFilter, p: AutoModeFilter): AutoModeFilter => ({
    include: p.include.length > 0 ? p.include : g.include,
    exclude: unique([...g.exclude, ...p.exclude]),
  });
  return {
    agents: merge(global.agents, project.agents),
    models: merge(global.models, project.models),
    priority: project.priority ?? global.priority,
    notes: { project: project.notes, global: global.notes },
  };
}

/** Compiles a case-insensitive glob where `*` matches any run of characters. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * The names an agent answers to. Launcher ids are plugin-qualified
 * (`pragma.claude-code`, `@pragma-sh/claude-code-plugin.claude-code`), but
 * users write the short id (`claude-code`), so both the full id and its final
 * dot segment match.
 */
export function shortAgentId(agentId: string): string {
  return agentId.split(".").at(-1) ?? agentId;
}

function agentAliases(agentId: string): string[] {
  const short = shortAgentId(agentId);
  return short === agentId ? [agentId] : [agentId, short];
}

/** Whether any glob names this agent by its full or short id. */
function matchesAgent(patterns: readonly string[], agentId: string): boolean {
  return agentAliases(agentId).some((alias) => matchesAny(patterns, alias));
}

/** A model pattern split into its optional agent scope and model glob. */
interface ModelPattern {
  agent: string | null;
  model: string;
}

/**
 * Splits `agent/model`. Only the first slash separates, and only when the text
 * before it names an agent — OpenCode model ids are themselves
 * `provider/model`, so `anthropic/claude-*` must stay a bare model pattern.
 */
function splitModelPattern(pattern: string, agentIds: readonly string[]): ModelPattern {
  const slash = pattern.indexOf("/");
  if (slash > 0) {
    const agent = pattern.slice(0, slash);
    if (agentIds.some((id) => matchesAgent([agent], id))) {
      return { agent, model: pattern.slice(slash + 1) };
    }
  }
  return { agent: null, model: pattern };
}

function patternsForAgent(
  patterns: readonly string[],
  agentId: string,
  agentIds: readonly string[],
): string[] {
  return patterns
    .map((pattern) => splitModelPattern(pattern, agentIds))
    .filter((pattern) => pattern.agent === null || matchesAgent([pattern.agent], agentId))
    .map((pattern) => pattern.model);
}

function keepModel(
  model: { id: string },
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (matchesAny(exclude, model.id)) return false;
  return include.length === 0 || matchesAny(include, model.id);
}

/**
 * Applies the hard filters. An agent whose every listed model was filtered out
 * is dropped. An agent whose model list is unknown (discovery failed or timed
 * out) is kept only when no model filter names it: with a filter active we
 * cannot prove its default model is allowed, and a launch with no model id
 * would fall back to exactly the model the user may have excluded.
 */
export function applyAutoModeFilters<C extends AutoModeCandidate>(
  candidates: readonly C[],
  preferences: Pick<MergedAutoModePreferences, "agents" | "models">,
): C[] {
  const agentIds = candidates.map((candidate) => candidate.id);
  const out: C[] = [];
  for (const candidate of candidates) {
    if (matchesAgent(preferences.agents.exclude, candidate.id)) continue;
    const { include } = preferences.agents;
    if (include.length > 0 && !matchesAgent(include, candidate.id)) continue;

    const modelInclude = patternsForAgent(preferences.models.include, candidate.id, agentIds);
    const modelExclude = patternsForAgent(preferences.models.exclude, candidate.id, agentIds);
    if (candidate.models.length === 0) {
      if (modelInclude.length > 0 || modelExclude.length > 0) continue;
      out.push({ ...candidate, models: [] });
      continue;
    }
    const models = candidate.models.filter((model) => keepModel(model, modelInclude, modelExclude));
    if (models.length === 0) continue;
    out.push({ ...candidate, models });
  }
  return out;
}
