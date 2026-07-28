import type { BrowserDesignStage, DesignPalette } from "@/lib/tauri";

/**
 * Design mode: picking elements in a locally-served page and handing the picked
 * markup plus the user's prompts to an agent.
 *
 * The overlay itself lives inside the native browser webview (see
 * `design_script` in `browser.rs`); these pure helpers decide when the toolbar
 * exposes design mode and turn staged changes into the agent's prompt, and are
 * unit-tested in isolation.
 */

/** CSS custom properties read for each {@link DesignPalette} field. */
const PALETTE_TOKENS: Record<Exclude<keyof DesignPalette, "fontFamily">, string> = {
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  primaryHover: "--primary-hover",
  surface: "--popover",
  surfaceForeground: "--popover-foreground",
  border: "--border",
  mutedForeground: "--muted-foreground",
  ring: "--ring",
};

/**
 * Reads the app's current theme tokens off the live document, so the in-page
 * design overlay can be painted in the same colors as the rest of Pragma.
 * Unset tokens come back empty; the overlay falls back to its own defaults for
 * those.
 */
export function readDesignPalette(target: Document = document): DesignPalette {
  const computed = getComputedStyle(target.documentElement);
  const read = (token: string) => computed.getPropertyValue(token).trim();
  return {
    primary: read(PALETTE_TOKENS.primary),
    primaryForeground: read(PALETTE_TOKENS.primaryForeground),
    primaryHover: read(PALETTE_TOKENS.primaryHover),
    surface: read(PALETTE_TOKENS.surface),
    surfaceForeground: read(PALETTE_TOKENS.surfaceForeground),
    border: read(PALETTE_TOKENS.border),
    mutedForeground: read(PALETTE_TOKENS.mutedForeground),
    ring: read(PALETTE_TOKENS.ring),
    fontFamily: computed.fontFamily.trim(),
  };
}

/** Hostnames that always mean "this machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * Whether a page is a local dev server — a loopback host **with an explicit
 * port**. Design mode is only useful there (the agent needs source it can
 * edit), so the toolbar promotes its toggle for these URLs and hides it in the
 * overflow menu for everything else.
 */
export function isLocalPortUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.port) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/** The origin (`http://localhost:5173`) a set of staged changes was picked on. */
function pageOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return pageUrl;
  }
}

/** The port a set of staged changes was picked on, or `null` when unparsable. */
function pagePort(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).port || null;
  } catch {
    return null;
  }
}

/** Renders one staged change as a markdown section for the agent prompt. */
function renderChange(change: BrowserDesignStage, index: number): string {
  const lines = [
    `## Change ${index + 1}`,
    "",
    `- Route: \`${change.route}\``,
    `- Page: ${change.url}`,
    `- Selector: \`${change.selector}\``,
  ];
  if (change.ancestors) {
    lines.push(`- Ancestors: \`${change.ancestors}\``);
  }
  lines.push(
    "",
    "Code area to change (rendered HTML of the selected element):",
    "",
    "```html",
    change.html,
    "```",
    "",
    "What the user asked for:",
    "",
    `> ${change.prompt.split("\n").join("\n> ")}`,
  );
  return lines.join("\n");
}

/**
 * Builds the prompt handed to the agent launched from design mode: where the
 * app is running, every staged change with the markup it was picked from, and
 * the user's own words for each.
 */
export function buildDesignPrompt(changes: readonly BrowserDesignStage[], pageUrl: string): string {
  const origin = pageOrigin(pageUrl);
  const port = pagePort(pageUrl);
  const where = port ? `${origin} (port ${port})` : origin;
  const plural = changes.length === 1 ? "change" : "changes";
  return [
    `The user picked ${changes.length} ${plural} in Pragma's browser using design mode.`,
    `The app is running locally at ${where}.`,
    "",
    `Verify each change below against the running app at ${origin}, find the source that`,
    "renders the given markup on the given route, then make the change the user asked for.",
    "",
    ...changes.map((change, index) => `${renderChange(change, index)}\n`),
    "For each change: locate the component or template that produces that HTML on that route,",
    "apply the requested change, and confirm it renders as expected in the running app.",
  ].join("\n");
}
