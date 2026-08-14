/**
 * The "Created with Pragma" footer Pragma appends to pull requests it opens.
 *
 * The block is delimited by HTML comment markers so it round-trips: it is added
 * once at creation ({@link appendPrSignature}) and removed again whenever a body
 * is read back ({@link stripPrSignature}), so a Pragma user never sees the
 * marketing block inside the app — only people reading the PR on GitHub do.
 */

import { constants, type GitHubSettings } from "@pragma/constants";

import { readConfig } from "@/lib/tauri";

const CONFIG_CHANGED_EVENT = "pragma:config-changed";
const { prSignature } = constants.github;

/** Cached global setting; a Settings save invalidates it via `pragma:config-changed`. */
let cachedEnabled: Promise<boolean> | null = null;
let listeningForConfigChanges = false;

/**
 * Validates the `github` block of the global `.pragma/config.json`. Throws so a
 * malformed block surfaces in Settings instead of silently changing what Pragma
 * writes into other people's repositories.
 */
export function validateGitHubSettings(value: unknown): GitHubSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("github must be an object");
  }
  const settings = value as GitHubSettings;
  if (settings.prSignature !== undefined && typeof settings.prSignature !== "boolean") {
    throw new Error("github.prSignature must be a boolean");
  }
  return settings;
}

/** Drops the cached setting after a Settings save. */
export function resetPrSignatureCache(): void {
  cachedEnabled = null;
}

function watchConfigChanges(): void {
  if (listeningForConfigChanges || typeof window === "undefined") return;
  listeningForConfigChanges = true;
  window.addEventListener(CONFIG_CHANGED_EVENT, resetPrSignatureCache);
}

/**
 * Whether the footer is enabled. The setting is global-only (`github.prSignature`
 * in `~/.pragma/config.json`) — a project cannot opt its contributors in or out.
 */
function prSignatureEnabled(): Promise<boolean> {
  watchConfigChanges();
  if (cachedEnabled) return cachedEnabled;
  const resolved = (async () => {
    try {
      const document = await readConfig("global");
      const parsed = JSON.parse(document.contents || "{}") as { github?: unknown };
      return validateGitHubSettings(parsed.github).prSignature ?? prSignature.enabled;
    } catch {
      // An unreadable or malformed config falls back to the shipped default
      // rather than silently changing what a PR body says.
      return prSignature.enabled;
    }
  })();
  cachedEnabled = resolved;
  return resolved;
}

/**
 * Renders the footer block for one worktree.
 *
 * The link points at the `openUrl` web redirector rather than the deep link
 * itself, because GitHub's markdown sanitizer keeps only `http`/`https`/`mailto`
 * hrefs — a `pragma://` URL would render as inert text. The redirector forwards
 * `worktree` to `pragma://open`, which resolves only on the machine that owns
 * that worktree; elsewhere Pragma ignores the unknown id and the link degrades
 * to "open Pragma".
 */
export function buildPrSignature(worktreeId: string | null): string {
  const heading = `### [Created with Pragma](${constants.github.homepageUrl})`;
  const tagline = "<sub>A terminal agentic development environment</sub>";
  const target = worktreeId
    ? `${prSignature.openUrl}?worktree=${encodeURIComponent(worktreeId)}`
    : prSignature.openUrl;
  const link = `<sub>[${prSignature.linkLabel}](${target})</sub>`;
  const optOut =
    "<sub>Turn this off in Pragma → Settings → GitHub → “Created with Pragma” pull-request footer.</sub>";
  return [
    prSignature.startMarker,
    "",
    // A rule separates the footer from whatever the author wrote above it.
    "---",
    "",
    heading,
    "",
    tagline,
    "",
    link,
    "",
    optOut,
    "",
    prSignature.endMarker,
  ].join("\n");
}

/**
 * Appends the footer to a PR body, replacing any footer the body already carries
 * so a regenerated draft cannot stack two of them. Returns the body unchanged
 * when the user has turned the footer off.
 */
export async function appendPrSignature(body: string, worktreeId: string | null): Promise<string> {
  if (!(await prSignatureEnabled())) return stripPrSignature(body);
  const base = stripPrSignature(body);
  const signature = buildPrSignature(worktreeId);
  return base ? `${base}\n\n${signature}\n` : `${signature}\n`;
}

/**
 * Removes every Pragma footer block from a PR body, so the app renders and edits
 * only what the author actually wrote. Unterminated blocks (a body truncated by
 * GitHub's 65 536-character limit) are cut to the end.
 */
export function stripPrSignature(body: string): string {
  let result = body;
  let removedSignature = false;
  for (;;) {
    const start = result.indexOf(prSignature.startMarker);
    if (start === -1) break;
    removedSignature = true;
    const endIndex = result.indexOf(prSignature.endMarker, start);
    const end = endIndex === -1 ? result.length : endIndex + prSignature.endMarker.length;
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return removedSignature ? result.trimEnd() : body;
}
