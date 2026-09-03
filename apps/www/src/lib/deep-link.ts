/**
 * Web-side deep-link plumbing.
 *
 * GitHub's markdown sanitizer keeps only `http`/`https` hrefs, so links that
 * must survive a PR body (and any other context that filters custom schemes)
 * point at web routes on this site (`/{action}?...`) that hand the query off to
 * the matching `pragma://` deep link. The routes live under `src/app/(home)/`
 * — one page per action, each rendering {@link DeepLinkForward}.
 */

/** Builds the `pragma://` target a forwarder page relays to. */
export function pragmaDeepLinkUrl(action: string, query: string): string {
  return query ? `pragma://${action}?${query}` : `pragma://${action}`;
}

/**
 * Builds the same-origin forwarder route for a deep link. `query` values are
 * re-encoded canonically; the desktop parser is tolerant of that.
 */
export function webDeepLinkUrl(action: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return search ? `/${action}?${search}` : `/${action}`;
}

/**
 * Flattens a forwarder page's `searchParams` into the query string forwarded to
 * the `pragma://` scheme. Repeated params collapse to their last value, matching
 * the desktop parser's "last non-empty value wins" rule.
 */
export function deepLinkQuery(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const resolved = Array.isArray(value) ? value.at(-1) : value;
    if (resolved !== undefined && resolved !== "") search.set(key, resolved);
  }
  return search.toString();
}
