/**
 * Parsed `pragma://open` deep link that drives the new-chat flow.
 *
 * Every field is optional from the URL's perspective: an absent query param
 * leaves the corresponding value `null` (or `false` for {@link autoSubmit}), and
 * the consumer fills the gap (default agent, current worktree, empty prompt).
 */
export interface NewChatDeepLink {
  /** Requested agent id (`agent`); the consumer falls back to the default when absent or unknown. */
  agentId: string | null;
  /** Prompt to prefill (`message`), already base64-decoded for display. */
  message: string | null;
  /** Target worktree branch id (`worktree`). */
  worktreeId: string | null;
  /** When truthy (`autoSubmit`), launch immediately and bypass the new-chat dialog. */
  autoSubmit: boolean;
}

/**
 * Detail payload of the `pragma:new-chat` window event. The workspace dispatches
 * it after handling a non-auto-submit deep link; the sidebar listens and opens
 * the new-chat dialog seeded with these values.
 */
export interface NewChatDeepLinkDetail {
  agentId: string | null;
  worktreeId: string | null;
  message: string | null;
}

/** Window event name carrying a {@link NewChatDeepLinkDetail}. */
export const NEW_CHAT_EVENT = "pragma:new-chat";

/**
 * Buffer for the most recent new-chat request. A cold-start deep link is handled
 * before the sidebar's {@link NEW_CHAT_EVENT} listener mounts, so the event alone
 * would be lost; the buffer lets the listener drain the request once on mount.
 */
let pendingNewChat: NewChatDeepLinkDetail | null = null;

/**
 * Requests the prefilled new-chat dialog. Dispatches {@link NEW_CHAT_EVENT} for an
 * already-mounted listener and buffers the request so a listener mounting later
 * (e.g. on cold start from a deep link) can still drain it via
 * {@link consumePendingNewChat}.
 */
export function requestNewChat(detail: NewChatDeepLinkDetail): void {
  pendingNewChat = detail;
  window.dispatchEvent(new CustomEvent<NewChatDeepLinkDetail>(NEW_CHAT_EVENT, { detail }));
}

/** Returns and clears the buffered new-chat request, if any. */
export function consumePendingNewChat(): NewChatDeepLinkDetail | null {
  const detail = pendingNewChat;
  pendingNewChat = null;
  return detail;
}

/** The single deep-link scheme Pragma owns. */
const DEEP_LINK_SCHEME = "pragma:";
/** The only deep-link host/action currently supported: open the new-chat flow. */
const DEEP_LINK_OPEN_HOST = "open";

/**
 * Parses a `pragma://open?...` deep link into a {@link NewChatDeepLink}, or
 * returns `null` when the URL is malformed or not a `pragma://open` link.
 *
 * Recognised query params: `agent`, `message` (base64), `worktree`, `autoSubmit`.
 */
export function parseNewChatDeepLink(raw: string): NewChatDeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== DEEP_LINK_SCHEME || url.hostname !== DEEP_LINK_OPEN_HOST) {
    return null;
  }
  const params = url.searchParams;
  return {
    agentId: lastParam(params, "agent"),
    message: decodeMessage(lastRawParam(url.search, "message")),
    worktreeId: lastParam(params, "worktree"),
    autoSubmit: isTruthy(lastParam(params, "autoSubmit")),
  };
}

/** Returns the last non-empty value for a query param, making duplicate params deterministic. */
function lastParam(params: URLSearchParams, name: string): string | null {
  const values = params
    .getAll(name)
    .map(emptyToNull)
    .filter((value) => value !== null);
  return values.at(-1) ?? null;
}

/**
 * Returns the last raw query value for a param. Used for base64 payloads so `+`
 * remains `+` instead of being treated as form-encoded space by URLSearchParams.
 */
function lastRawParam(search: string, name: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const values: string[] = [];
  for (const part of query.split("&")) {
    if (!part) {
      continue;
    }
    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const key = decodeQueryComponent(rawKey);
    if (key !== name) {
      continue;
    }
    const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);
    const value = decodeQueryComponent(rawValue);
    if (value !== null && value.length > 0) {
      values.push(value);
    }
  }
  return values.at(-1) ?? null;
}

/** Percent-decodes a query component without applying form-style `+` to space conversion. */
function decodeQueryComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Normalises an empty-string param to `null` so callers can treat it as absent. */
function emptyToNull(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Base64-decodes the `message` param (UTF-8 aware, tolerant of URL-safe base64).
 * Falls back to the raw value if it is not valid base64 so a hand-written link
 * still shows *something* rather than being silently dropped.
 */
function decodeMessage(value: string | null): string | null {
  const trimmed = emptyToNull(value);
  if (trimmed === null) {
    return null;
  }
  try {
    const normalized = trimmed.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return trimmed;
  }
}

/** Treats a query param as truthy unless it is absent or an explicit falsy token. */
function isTruthy(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}
