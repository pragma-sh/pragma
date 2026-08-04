import { constants, type TabKind } from "@pragma/constants";

/**
 * The fallback title for a tab whose shell/page hasn't named it — or that
 * cleared its name (e.g. a TUI like opencode emitting an empty OSC 0/2 title on
 * exit). Keeps a tab from ever showing a blank label. Shared with the gateway,
 * which treats a tab still carrying its default title as unnamed.
 */
export function defaultTabTitle(kind: TabKind): string {
  const titles = constants.tabs.defaultTitles;
  if (kind === "browser") {
    return titles.browser;
  }
  if (kind === "log") {
    return titles.log;
  }
  if (kind === "pr-review") {
    return titles.prReview;
  }
  if (kind === "plugin-webview") {
    return titles.pluginWebview;
  }
  return titles.fallback;
}
