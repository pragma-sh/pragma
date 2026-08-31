import { getBridge } from "./bridge";
import type { PluginSessionSummary } from "./types";

/** Returns the host's current color theme outside React. */
export function getTheme(): "light" | "dark" {
  return getBridge().actions.theme.get();
}

/** Subscribes to color-theme changes outside React. Returns an unsubscribe function. */
export function subscribeTheme(listener: (theme: "light" | "dark") => void): () => void {
  const theme = getBridge().actions.theme;
  return theme.subscribe(() => {
    listener(theme.get());
  });
}

/** Subscribes to a named host event outside React. Returns an unsubscribe function. */
export function subscribeEvent<TPayload = unknown>(
  eventName: string,
  handler: (payload: TPayload) => void,
): () => void {
  return getBridge().actions.events.subscribe(eventName, (payload) => {
    handler(payload as TPayload);
  });
}

/** Lists current host sessions outside React. */
export function listSessions(): Promise<PluginSessionSummary[]> {
  return getBridge().actions.sessions.list();
}
