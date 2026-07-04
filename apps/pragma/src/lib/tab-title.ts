import type { TabKind } from "@pragma/constants";

/**
 * The fallback title for a tab whose shell/page hasn't named it — or that
 * cleared its name (e.g. a TUI like opencode emitting an empty OSC 0/2 title on
 * exit). Keeps a tab from ever showing a blank label.
 */
export function defaultTabTitle(kind: TabKind): string {
  if (kind === "browser") {
    return "New tab";
  }
  if (kind === "log") {
    return "Server Logs";
  }
  if (kind === "pr-review") {
    return "PR Review";
  }
  if (kind === "plugin-webview") {
    return "Plugin";
  }
  return "Shell";
}
