/**
 * `.pragma/theme.json` parsing, layering and application.
 *
 * A theme file is optional and may exist at two scopes — `~/.pragma/theme.json`
 * (global) and `<project>/.pragma/theme.json`. Layers merge per token:
 * `index.css` defaults <- global <- project, so a project only states what it
 * changes. Overrides are applied by injecting one stylesheet at the end of
 * `<head>`; nothing mutates inline styles, so an unset token keeps whatever
 * `index.css` says.
 */

import { constants } from "@pragma/constants";

import { isCssColor } from "@/lib/theme-color";
import { THEME_DEFAULTS, THEME_TOKENS, type ThemeMode } from "@/lib/theme-tokens";

/** Overrides for one color scheme, keyed by token name (no `--` prefix). */
export type ThemeOverrides = Partial<Record<string, string>>;

/**
 * The parsed shape of a `.pragma/theme.json` file. Unrecognised top-level keys
 * (`$schema`, comments a user added) are kept so a rewrite never drops them.
 */
export interface ThemeFile {
  colors?: Partial<Record<ThemeMode, ThemeOverrides>>;
  [key: string]: unknown;
}

/** Element id of the injected override stylesheet. */
const STYLE_ELEMENT_ID = "pragma-theme-overrides";

/**
 * Selectors for the injected overrides. Each doubles its class so explicit
 * user colors outrank defaults in `index.css`.
 */
const OVERRIDE_SELECTORS: Record<ThemeMode, string> = {
  light: ":root:root",
  dark: ".dark.dark",
};

/** Window event dispatched after a theme file is written, so open views reload. */
export const THEME_CHANGED_EVENT = "pragma:theme-changed";

/** Relative path of a theme file within its scope root. */
export const THEME_FILE_NAME = constants.theme.fileName;

/** Every color scheme a theme file may declare. */
export const THEME_MODES: readonly ThemeMode[] = constants.theme.modes;

/**
 * Parses theme-file contents. Unknown token names are ignored rather than
 * rejected — a theme written by a newer Pragma must not break an older one —
 * but structural mistakes throw so Settings can surface them.
 */
export function parseThemeFile(contents: string): ThemeFile {
  const trimmed = contents.trim();
  if (!trimmed) return {};
  const value = JSON.parse(trimmed) as unknown;
  if (!isPlainObject(value)) throw new Error("theme.json root must be an object");
  const colors = value.colors;
  if (colors === undefined) return { ...value };
  if (!isPlainObject(colors)) throw new Error("theme.json `colors` must be an object");
  const parsed: ThemeFile["colors"] = {};
  for (const mode of THEME_MODES) {
    const block = colors[mode];
    if (block === undefined) continue;
    if (!isPlainObject(block)) throw new Error(`theme.json \`colors.${mode}\` must be an object`);
    parsed[mode] = parseOverrides(block, mode);
  }
  return { ...value, colors: parsed };
}

function parseOverrides(block: Record<string, unknown>, mode: ThemeMode): ThemeOverrides {
  const overrides: ThemeOverrides = {};
  for (const [token, value] of Object.entries(block)) {
    if (typeof value !== "string") {
      throw new Error(`theme.json \`colors.${mode}.${token}\` must be a color string`);
    }
    if (!isCssColor(value)) {
      throw new Error(`theme.json \`colors.${mode}.${token}\` is not a valid CSS color: ${value}`);
    }
    overrides[token] = value;
  }
  return overrides;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Layers theme files in precedence order (later wins) and drops tokens Pragma
 * does not know about.
 */
export function mergeThemeOverrides(
  mode: ThemeMode,
  ...layers: readonly (ThemeFile | null | undefined)[]
): ThemeOverrides {
  const merged: ThemeOverrides = {};
  for (const layer of layers) {
    for (const [token, value] of Object.entries(layer?.colors?.[mode] ?? {})) {
      if (value && THEME_TOKENS.includes(token)) merged[token] = value;
    }
  }
  for (const [token, value] of Object.entries(merged)) {
    if (value === THEME_DEFAULTS[mode][token]) delete merged[token];
  }
  return merged;
}

/**
 * Returns a copy of a theme file with one token set, or removed when `value` is
 * `null`. Emptied `colors` blocks are pruned so resetting the last override
 * leaves a clean file instead of a husk.
 */
export function withThemeOverride(
  file: ThemeFile | null,
  mode: ThemeMode,
  token: string,
  value: string | null,
): ThemeFile {
  const colors = { ...file?.colors };
  const block = { ...colors[mode] };
  if (value === null) delete block[token];
  else block[token] = value;
  if (Object.keys(block).length === 0) delete colors[mode];
  else colors[mode] = block;
  const next: ThemeFile = { ...file, colors };
  if (Object.keys(colors).length === 0) delete next.colors;
  return next;
}

/** Serializes a theme file the way Settings writes it: 2-space JSON, trailing newline. */
export function serializeThemeFile(file: ThemeFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The value a token resolves to for a mode: the override, else the CSS default. */
export function resolveThemeToken(
  mode: ThemeMode,
  token: string,
  overrides: ThemeOverrides,
): string {
  return overrides[token] ?? THEME_DEFAULTS[mode][token] ?? "transparent";
}

/** Renders the override stylesheet; empty when nothing is overridden. */
export function themeOverridesCss(overrides: Partial<Record<ThemeMode, ThemeOverrides>>): string {
  const blocks: string[] = [];
  for (const mode of THEME_MODES) {
    const entries = Object.entries(overrides[mode] ?? {}).filter(([token]) =>
      THEME_TOKENS.includes(token),
    );
    if (entries.length === 0) continue;
    const declarations = entries.map(([token, value]) => `  --${token}: ${value};`).join("\n");
    blocks.push(`${OVERRIDE_SELECTORS[mode]} {\n${declarations}\n}`);

    const sidebar = overrides.dark?.sidebar;
    if (mode === "dark" && sidebar) {
      blocks.push(
        `.dark.dark.vibrancy {\n  --sidebar: color-mix(in oklch, ${sidebar} 40%, transparent);\n}`,
      );
    }
  }
  return blocks.join("\n\n");
}

/**
 * Applies overrides to the document. Re-appending the element keeps it last in
 * `<head>`, which is what makes equal-specificity rules from `index.css` lose.
 */
export function applyThemeOverrides(
  overrides: Partial<Record<ThemeMode, ThemeOverrides>>,
  target: Document = document,
): void {
  const css = themeOverridesCss(overrides);
  const existing = target.querySelector(`#${STYLE_ELEMENT_ID}`);
  if (!css) {
    existing?.remove();
    return;
  }
  const element = existing ?? target.createElement("style");
  element.id = STYLE_ELEMENT_ID;
  element.textContent = css;
  target.head.append(element);
}
