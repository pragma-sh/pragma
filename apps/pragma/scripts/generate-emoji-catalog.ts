/**
 * Generates `src/generated/emoji-catalog.ts` from `emojibase-data`.
 *
 * The emoji list is Unicode's, not ours: `emojibase-data/en/compact.json` is
 * CLDR-derived (glyph, English label, keyword tags, group), and
 * `en/messages.json` names the groups. Regenerate with `bun run generate` after
 * bumping the dependency.
 *
 * Only the four fields the picker reads are emitted, as nested tuples — the
 * upstream JSON is 571 KB and most of it (hexcodes, sort orders, skin-tone
 * variants, emoticons) would be dead weight in the webview bundle.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import compact from "emojibase-data/en/compact.json" with { type: "json" };
import messages from "emojibase-data/en/messages.json" with { type: "json" };

/** Skin-tone modifiers and regional indicators — not standalone icons. */
const COMPONENT_GROUP = 2;

const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "generated",
  "emoji-catalog.ts",
);

/**
 * Extra search terms for glyphs a developer reaches for by tool name. These are
 * synonyms layered onto upstream labels, never new entries — the set of emoji
 * stays exactly what `emojibase-data` ships.
 *
 * Keys are matched with the variation selector stripped, so they can be written
 * as the bare glyph: emojibase fully-qualifies emoji-presentation characters
 * (its "package" is `1f4e6 fe0f`, not `1f4e6`).
 */
const EXTRA_TERMS: Record<string, string> = {
  "🐳": "docker container",
  "🦀": "rust cargo",
  "🐍": "python",
  "🐙": "git github octocat",
  "🐧": "linux",
  "🦊": "firefox gitlab",
  "🚀": "deploy ship release",
  "🏁": "ship release finish",
  "📦": "package bundle release npm",
  "🧩": "plugin extension module",
  "🪝": "webhook hook",
  "⚙️": "config settings",
  "🐛": "bug defect issue",
  "🧪": "test experiment",
  "⚡": "fast performance",
  "🤖": "bot agent ai",
  "🧠": "ai model",
  "⏱️": "benchmark latency",
  "🔑": "auth token secret",
  "🛡️": "security",
};

/** U+FE0F, the emoji-presentation variation selector. */
const VARIATION_SELECTOR = "\u{fe0f}";

/** A glyph with any emoji-presentation selector removed, for keying lookups. */
function baseGlyph(glyph: string): string {
  return glyph.replaceAll(VARIATION_SELECTOR, "");
}

interface CompactEmoji {
  unicode: string;
  label: string;
  group?: number;
  tags?: string[];
}

interface GroupMessage {
  key: string;
  message: string;
  order: number;
}

/** Title-cases the CLDR group message ("food & drink" → "Food & drink"). */
function groupTitle(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** Lowercase label plus tags and any extra terms, deduplicated. */
function searchLabel(emoji: CompactEmoji): string {
  const terms = [emoji.label, ...(emoji.tags ?? [])];
  const extra = EXTRA_TERMS[baseGlyph(emoji.unicode)];
  if (extra) {
    terms.push(extra);
  }
  const words = terms.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].join(" ");
}

/**
 * Fails the build when an `EXTRA_TERMS` key is not a glyph `emojibase-data`
 * ships. Variation selectors make these easy to mistype, and a key that matches
 * nothing would silently add no search terms at all.
 */
function assertExtraTermsResolve(known: Set<string>): void {
  const missing = Object.keys(EXTRA_TERMS).filter((glyph) => !known.has(baseGlyph(glyph)));
  if (missing.length > 0) {
    const detail = missing
      .map(
        (glyph) => `${glyph} (${[...glyph].map((c) => c.codePointAt(0)?.toString(16)).join(" ")})`,
      )
      .join(", ");
    throw new Error(`EXTRA_TERMS keys not present in emojibase-data: ${detail}`);
  }
}

/** Pickable groups in Unicode order, i.e. everything but the component group. */
function pickableGroups(): GroupMessage[] {
  return (messages.groups as GroupMessage[])
    .filter((group) => group.order !== COMPONENT_GROUP)
    .toSorted((left, right) => left.order - right.order);
}

/** True for emoji that belong in a picker group, narrowing `group` to a number. */
function isPickable(emoji: CompactEmoji): emoji is CompactEmoji & { group: number } {
  return emoji.group !== undefined && emoji.group !== COMPONENT_GROUP;
}

/** Pickable emoji bucketed by their group's order. */
function emojiByGroup(): Map<number, CompactEmoji[]> {
  const byGroup = new Map<number, CompactEmoji[]>();
  for (const emoji of (compact as CompactEmoji[]).filter(isPickable)) {
    const bucket = byGroup.get(emoji.group) ?? [];
    bucket.push(emoji);
    byGroup.set(emoji.group, bucket);
  }
  return byGroup;
}

/** One `[groupName, [[glyph, label], …]]` literal. */
function renderGroup(group: GroupMessage, emoji: CompactEmoji[]): string {
  const entries = emoji
    .map((entry) => `    [${JSON.stringify(entry.unicode)}, ${JSON.stringify(searchLabel(entry))}]`)
    .join(",\n");
  return `  [${JSON.stringify(groupTitle(group.message))}, [\n${entries},\n  ]]`;
}

function render(): string {
  assertExtraTermsResolve(
    new Set((compact as CompactEmoji[]).map((emoji) => baseGlyph(emoji.unicode))),
  );
  const byGroup = emojiByGroup();
  const body = pickableGroups()
    .map((group) => renderGroup(group, byGroup.get(group.order) ?? []))
    .join(",\n");

  return `// Generated by scripts/generate-emoji-catalog.ts from emojibase-data.
// Do not edit by hand — run \`bun run generate\` in apps/pragma instead.

/** \`[groupName, [[glyph, "label tags"], …]]\`, in Unicode group order. */
export const EMOJI_GROUP_DATA: ReadonlyArray<
  readonly [string, ReadonlyArray<readonly [string, string]>]
> = [
${body},
];
`;
}

const next = render();
await mkdir(dirname(OUTPUT), { recursive: true });
const current = await readFile(OUTPUT, "utf8").catch(() => null);
if (current !== next) {
  // Written through a temp file because `typecheck` and `test` each run this
  // script and turbo may run them at once: a rename is atomic, so a concurrent
  // reader sees either the old file or the new one, never a half-written one.
  const temporary = `${OUTPUT}.${process.pid}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, OUTPUT);
}
console.log(`src/generated/emoji-catalog.ts ${current === next ? "up to date" : "written"}`);
