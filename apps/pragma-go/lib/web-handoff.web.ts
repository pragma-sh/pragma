import type { ConnectionConfig } from "./pairing";

// The web build is served by the gateway it talks to, so the origin *is* the
// host URL — a browser user never types one. Only the token has to travel, and
// it rides in the URL fragment: fragments are not sent to the server, so the
// token never lands in a tunnel's access log, a proxy's, or a Referer header.
// It is consumed once and erased from the address bar so a copied URL or a
// bookmark cannot carry a live token onward.

const TOKEN_FRAGMENT_KEY = "t";

/**
 * Reads a `#t=<token>` handoff from the current URL and clears it. Returns the
 * connection it implies, or null when the page was opened without one.
 */
export function takeTokenFromUrl(): ConnectionConfig | null {
  const token = consumeTokenFragment();
  return token ? { url: defaultGatewayUrl(), token } : null;
}

/** Reads the token out of the fragment and erases it, or returns null. */
function consumeTokenFragment(): string | null {
  const params = fragmentParams(currentHash());
  if (!params.has(TOKEN_FRAGMENT_KEY)) return null;
  // Erase as soon as the fragment is known to name a token, even if the value
  // turns out to be empty, so a bad link is not left in the address bar to be
  // copied onward.
  clearFragment();
  return trimmedOrNull(params.get(TOKEN_FRAGMENT_KEY));
}

/** Parses a URL fragment as query parameters; empty when there is no fragment. */
function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : "");
}

/** The page's fragment, or empty outside a browser (tests, SSR-style checks). */
function currentHash(): string {
  return globalThis.location?.hash ?? "";
}

function trimmedOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The gateway URL a browser client should use: the origin that served the page,
 * minus the sub-path the bundle is deployed under. Falls back to the bare
 * origin when the app is served from the root (the metro dev server).
 */
export function defaultGatewayUrl(): string {
  const origin = globalThis.location?.origin ?? "";
  return origin.replace(/\/$/, "");
}

/**
 * Removes the fragment without adding a history entry, so Back does not restore
 * a URL that still carries the token.
 */
function clearFragment(): void {
  const { history, location } = globalThis;
  if (!history?.replaceState || !location) return;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}
