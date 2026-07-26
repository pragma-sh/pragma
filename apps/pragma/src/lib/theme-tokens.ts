/**
 * The catalog of themeable color tokens and their shipped default values.
 *
 * Defaults are read straight out of `index.css` at build time (`?raw`) rather
 * than mirrored here, so the stylesheet stays the single source of truth and the
 * Theme settings page can never claim a stale "default". Only the two canonical
 * variable blocks are parsed — `:root` (light) and `.dark` (dark); the vibrancy
 * and `@theme inline` blocks are deliberately ignored.
 */

import stylesheet from "@/index.css?raw";

/** Color-scheme block a theme token belongs to. */
export type ThemeMode = "light" | "dark";

/** Ordered token names keyed by mode. */
export type ThemeTokenValues = Record<string, string>;

/** A named group of tokens, used to section the Theme settings page. */
export interface ThemeTokenGroup {
  id: string;
  label: string;
  description: string;
  tokens: readonly string[];
}

/** CSS selector whose declaration block holds each mode's defaults. */
const MODE_SELECTORS: Record<ThemeMode, string> = {
  light: ":root",
  dark: ".dark",
};

/**
 * Groups mirror the section comments in `index.css`. Every color token parsed
 * from the stylesheet must appear in exactly one group — `theme-tokens.test.ts`
 * fails if a new variable is added to the CSS without being placed here.
 */
export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroup[] = [
  {
    id: "surfaces",
    label: "Surfaces",
    description: "Page canvas, panes, cards and popovers.",
    tokens: [
      "canvas",
      "background",
      "foreground",
      "elevated",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
    ],
  },
  {
    id: "controls",
    label: "Controls",
    description: "Buttons, inputs and other interactive chrome.",
    tokens: [
      "primary",
      "primary-foreground",
      "primary-hover",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
    ],
  },
  {
    id: "edges",
    label: "Edges & focus",
    description: "Hairlines, focus rings, text selection and modal scrims.",
    tokens: ["border", "input", "ring", "selection", "overlay"],
  },
  {
    id: "state",
    label: "State",
    description: "Colors that communicate state — never decoration.",
    tokens: [
      "destructive",
      "destructive-foreground",
      "success",
      "success-foreground",
      "warning",
      "warning-foreground",
      "skill",
      "skill-foreground",
      "diff-added",
      "diff-removed",
    ],
  },
  {
    id: "sidebar",
    label: "Sidebar",
    description: "The project rail and its tab strips.",
    tokens: [
      "sidebar",
      "sidebar-foreground",
      "sidebar-primary",
      "sidebar-primary-foreground",
      "sidebar-accent",
      "sidebar-accent-foreground",
      "sidebar-border",
      "sidebar-ring",
    ],
  },
];

/** Values that look like colors; `--radius` and friends are not themeable here. */
const COLOR_VALUE = /^(oklch|oklab|color|rgba?|hsla?|hwb|lab|lch)\(|^#[0-9a-f]{3,8}$/i;

const DECLARATION = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;

/**
 * Extracts the declaration block of a top-level rule whose selector matches
 * exactly — `:root {` or `.dark {`, never `.dark.vibrancy {`.
 */
function declarationBlock(css: string, selector: string): string {
  const start = new RegExp(`^${escapeSelector(selector)}\\s*\\{$`, "m").exec(css);
  if (!start) throw new Error(`index.css has no \`${selector}\` block`);
  const from = start.index + start[0].length;
  const end = css.indexOf("\n}", from);
  if (end === -1) throw new Error(`\`${selector}\` block in index.css is unterminated`);
  return css.slice(from, end);
}

function escapeSelector(selector: string): string {
  return selector.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function parseModeDefaults(css: string, mode: ThemeMode): ThemeTokenValues {
  const block = declarationBlock(css, MODE_SELECTORS[mode]);
  const values: ThemeTokenValues = {};
  for (const [, name, rawValue] of block.matchAll(DECLARATION)) {
    const value = rawValue?.trim();
    if (!name || !value || !COLOR_VALUE.test(value)) continue;
    values[name] = value;
  }
  return values;
}

/** Shipped default color values, per mode, parsed from `index.css`. */
export const THEME_DEFAULTS: Record<ThemeMode, ThemeTokenValues> = {
  light: parseModeDefaults(stylesheet, "light"),
  dark: parseModeDefaults(stylesheet, "dark"),
};

/** Every themeable token name, in group order. */
export const THEME_TOKENS: readonly string[] = THEME_TOKEN_GROUPS.flatMap((group) => group.tokens);

/** Human label for a token — `sidebar-primary-foreground` → `Sidebar primary foreground`. */
export function themeTokenLabel(token: string): string {
  const words = token.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
