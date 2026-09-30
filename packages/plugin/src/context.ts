import type { PluginIcon, PluginWhen } from "./contributions";
import type { PluginContext, PluginProject } from "./types";

/** Most items one provider contributes to the `@` picker. */
export const CONTEXT_PICKER_LIMIT = 8;

/**
 * One entry a context provider offers to the prompt's `@` picker. Picking it
 * inserts `@<displayName>` into the prompt; when the prompt is launched with
 * that mention still present, the provider's `resolve` supplies the text the
 * agent receives.
 */
export interface ContextItem<TData = unknown> {
  /** Stable id, unique within its provider. */
  id: string;
  /** Shown in the picker and inserted into the prompt as `@<displayName>`. */
  displayName: string;
  /** Text the typed `@query` is matched against. Defaults to `displayName`. */
  searchText?: string;
  /** Secondary line shown next to the name in the picker. */
  description?: string;
  /** Per-item icon component; falls back to the provider's icon. */
  icon?: PluginIcon;
  /** Per-item image (PNG/SVG URL, absolute path, or plugin-dir-relative asset path). */
  iconPath?: string;
  /** Opaque data handed back to `resolve`. Must be JSON-serializable. */
  data?: TData;
}

/** The worktree a prompt is being written for. */
export interface ContextWorktree {
  id: string;
  /** Absolute worktree path on its owning host. */
  path: string;
  branch: string;
}

/** Input to {@link ContextProviderDefinition.search}. */
export interface ContextSearchInput {
  /** What the user typed after `@` (may be empty). */
  query: string;
  project: PluginProject | null;
  worktree: ContextWorktree | null;
  /** Aborted when the query changes or the picker closes. */
  signal: AbortSignal;
}

/** Input to {@link ContextProviderDefinition.resolve}. */
export interface ContextResolveInput<TData = unknown> {
  item: ContextItem<TData>;
  project: PluginProject | null;
  worktree: ContextWorktree | null;
}

/**
 * A source of `@` context for agent prompts: files, issues, docs, tickets…
 * `search` lists candidate items (the host then filters and ranks them by
 * `searchText`, so returning a broad list is fine); `resolve` returns the text
 * injected into the prompt for a picked item.
 */
export interface ContextProviderDefinition<TConfig = unknown, TData = unknown> {
  /** Stable id, unique within the plugin. */
  id: string;
  /** Group heading in the picker (e.g. "Linear issues"). */
  title: string;
  /** Icon component for the provider and its items. */
  icon?: PluginIcon;
  /** Image for the provider and its items (PNG/SVG URL, absolute path, or plugin-relative path). */
  iconPath?: string;
  /** Hides the provider when it returns false. */
  when?: PluginWhen<TConfig>;
  /** Lists candidate items for the typed query. */
  search(
    input: ContextSearchInput,
    ctx: PluginContext<TConfig>,
  ): ContextItem<TData>[] | Promise<ContextItem<TData>[]>;
  /** Returns the context text the agent receives for a picked item. */
  resolve(input: ContextResolveInput<TData>, ctx: PluginContext<TConfig>): string | Promise<string>;
}

/**
 * Thrown from a provider's `search` to show `message` in the `@` picker instead
 * of results — e.g. "Sign in to Linear to see issues." Any other error is
 * logged and the provider shows nothing.
 */
export class ContextProviderNotice extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextProviderNotice";
  }
}

/**
 * Whether `cause` is a {@link ContextProviderNotice}. Checks the name, not the
 * class, because each plugin bundle carries its own copy of this module.
 */
export function isContextProviderNotice(cause: unknown): cause is ContextProviderNotice {
  return cause instanceof Error && cause.name === "ContextProviderNotice";
}

/** Declares an `@` context provider contribution. */
export function defineContextProvider<TConfig = unknown, TData = unknown>(
  input: ContextProviderDefinition<TConfig, TData>,
): ContextProviderDefinition<TConfig, TData> {
  return input;
}

/** The `@` mention token a context item inserts into the prompt. */
export function contextMention(item: Pick<ContextItem, "displayName">): string {
  return `@${item.displayName}`;
}

/**
 * The partial query when the text before the caret ends in an `@` mention
 * being typed (`@` at the start or after whitespace, no whitespace since),
 * otherwise `null`.
 */
export function contextQuery(textBeforeCaret: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(textBeforeCaret);
  return match ? match[1]! : null;
}

/**
 * Filters and ranks items by `searchText` (or `displayName`): prefix matches,
 * then substring matches, then in-order character (fuzzy) matches. An empty
 * query keeps the provider's order.
 */
export function matchContextItems<T extends ContextItem<unknown>>(
  items: readonly T[],
  query: string,
  limit: number = CONTEXT_PICKER_LIMIT,
): T[] {
  const needle = query.toLowerCase();
  if (!needle) return items.slice(0, limit);
  const ranked: { item: T; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const rank = matchRank((item.searchText ?? item.displayName).toLowerCase(), needle);
    if (rank !== null) ranked.push({ item, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, limit).map((entry) => entry.item);
}

function matchRank(haystack: string, needle: string): number | null {
  if (haystack.startsWith(needle)) return 0;
  if (haystack.includes(needle)) return 1;
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return 2;
  }
  return null;
}

/** One resolved context block appended to a prompt. */
export interface PromptContextBlock {
  /** The `@` mention as it appears in the prompt. */
  mention: string;
  /** Provider title, e.g. "GitHub issues". */
  source: string;
  content: string;
}

/**
 * Appends resolved context blocks to a prompt, one `<context>` element per
 * mention, so the agent can tell the user's request from the attached material.
 */
export function formatPromptWithContext(
  prompt: string,
  blocks: readonly PromptContextBlock[],
): string {
  const attached = blocks.filter((block) => block.content.trim());
  if (attached.length === 0) return prompt;
  const rendered = attached.map(
    (block) =>
      `<context mention="${escapeAttribute(block.mention)}" source="${escapeAttribute(block.source)}">\n${block.content.trim()}\n</context>`,
  );
  return [prompt.trimEnd(), ...rendered].join("\n\n");
}

const CONTEXT_START = '\n\n<context mention="';
const CONTEXT_BLOCK = /\n\n<context mention="([^"]*)" source="([^"]*)">\n([\s\S]*?)\n<\/context>/y;

/**
 * The inverse of {@link formatPromptWithContext}: splits a stored prompt into
 * the user's text and the context blocks appended to it, so an editor can show
 * the text alone and keep the blocks for the next save.
 */
export function splitPromptContext(stored: string): {
  prompt: string;
  blocks: PromptContextBlock[];
} {
  for (
    let at = stored.indexOf(CONTEXT_START);
    at !== -1;
    at = stored.indexOf(CONTEXT_START, at + 1)
  ) {
    const blocks = parseContextBlocks(stored, at);
    if (blocks) return { prompt: stored.slice(0, at), blocks };
  }
  return { prompt: stored, blocks: [] };
}

/** Parses `<context>` blocks from `from` to the end, or `null` if anything else follows. */
function parseContextBlocks(text: string, from: number): PromptContextBlock[] | null {
  const blocks: PromptContextBlock[] = [];
  CONTEXT_BLOCK.lastIndex = from;
  while (CONTEXT_BLOCK.lastIndex < text.length) {
    const match = CONTEXT_BLOCK.exec(text);
    if (!match) return null;
    blocks.push({
      mention: unescapeAttribute(match[1]!),
      source: unescapeAttribute(match[2]!),
      content: match[3]!,
    });
  }
  return blocks;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}
