/**
 * Snapshots the desktop's resolved theme variables for a scratchpad preview.
 *
 * A scratchpad renders in a sandboxed iframe with its own document, so it sees
 * neither Tailwind nor the app's stylesheet. Rather than restating any color —
 * which `index.css` owns, layered with `.pragma/theme.json` overrides — the
 * host reads the computed value of every themeable variable off the live root
 * element and hands the frame one `:root` block. The frame therefore follows
 * the active theme, including project overrides, with no duplicated defaults.
 */

import { THEME_DEFAULTS, THEME_TOKENS, type ThemeMode } from "@/lib/theme-tokens";

/**
 * Non-color variables the components also read. These come from the
 * `@theme inline` block, so they are not part of the themeable color catalog;
 * the fallbacks only matter under jsdom, where custom properties do not compute.
 */
const SUPPORT_VARIABLES: Readonly<Record<string, string>> = {
  "radius-sm": "6px",
  "radius-md": "8px",
  "radius-lg": "10px",
  "font-sans": "system-ui, sans-serif",
  "font-mono": "ui-monospace, monospace",
  "shadow-raised": "0 1px 2px rgb(0 0 0 / 0.3)",
};

/** Resolved theme of one document root: its color scheme and variable block. */
export interface ScratchpadTheme {
  mode: ThemeMode;
  css: string;
}

/**
 * Reads the desktop theme currently applied to `root` and renders it as a CSS
 * rule a scratchpad frame can adopt verbatim.
 */
export function scratchpadTheme(root: HTMLElement = document.documentElement): ScratchpadTheme {
  const mode: ThemeMode = root.classList.contains("dark") ? "dark" : "light";
  const computed = getComputedStyle(root);
  const declarations: string[] = [];
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(`--${token}`).trim() || THEME_DEFAULTS[mode][token];
    if (value) declarations.push(`--${token}:${value}`);
  }
  for (const [token, fallback] of Object.entries(SUPPORT_VARIABLES)) {
    const value = computed.getPropertyValue(`--${token}`).trim() || fallback;
    declarations.push(`--${token}:${value}`);
  }
  return { mode, css: `:root{color-scheme:${mode};${declarations.join(";")}}` };
}
