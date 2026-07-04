import type { PluginRecord } from "./registry";

const STYLE_ATTRIBUTE = "data-pragma-plugin-css";

/** Replaces active plugin CSS style tags with the current loaded record set. */
export function syncPluginCss(records: readonly PluginRecord[]): void {
  const active = new Map<string, string>();
  for (const record of records) {
    const css = record.status === "loaded" ? record.definition?.css : undefined;
    if (css && css.trim()) {
      active.set(record.pluginId, css);
    }
  }
  for (const element of document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`)) {
    const pluginId = element.getAttribute(STYLE_ATTRIBUTE);
    if (pluginId === null || !active.has(pluginId)) {
      element.remove();
    }
  }
  for (const [pluginId, css] of active) {
    let element = [
      ...document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`),
    ].find((candidate) => candidate.getAttribute(STYLE_ATTRIBUTE) === pluginId);
    if (!element) {
      element = document.createElement("style");
      element.setAttribute(STYLE_ATTRIBUTE, pluginId);
      document.head.append(element);
    }
    if (element.textContent !== css) {
      element.textContent = css;
    }
  }
}
