import type { constants } from "@pragma/constants";

/** A color scheme a `.pragma/theme.json` may declare under `colors`. */
export type ThemeMode = (typeof constants.theme.modes)[number];

/** Color overrides for one scheme, keyed by token name (no `--` prefix). */
export type ThemeOverrides = Partial<Record<string, string>>;

/** Which theme-file scopes existed on the host. */
export interface ThemeSources {
  /** `~/.pragma/theme.json` was present. */
  global: boolean;
  /** `<root>/.pragma/theme.json` was present (only when a root was requested). */
  project: boolean;
}

/**
 * The host's user theme: `global` layered under `project`, per token. Shipped
 * defaults are deliberately absent — they belong to the app doing the
 * rendering, so a client applies these on top of its own.
 */
export interface HostTheme {
  colors: Partial<Record<ThemeMode, ThemeOverrides>>;
  sources: ThemeSources;
}
