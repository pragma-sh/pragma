import { describe, expect, it, vi } from "vitest";

import {
  PLUGIN_DEEP_LINK_EVENT,
  parsePluginDeepLink,
  requestPluginDeepLink,
  type PluginDeepLinkDetail,
} from "./deep-link";

describe("plugin deep links", () => {
  it("parses pragma plugin URLs", () => {
    expect(parsePluginDeepLink("pragma://plugin/example/toggle?x=1&x=2")).toEqual({
      pluginId: "example",
      path: "toggle",
      url: "pragma://plugin/example/toggle?x=1&x=2",
      params: { x: ["1", "2"] },
    });
    expect(parsePluginDeepLink("pragma://open?agent=x")).toBeNull();
  });

  it("dispatches plugin deep-link events", () => {
    const listener = vi.fn<(event: CustomEvent<PluginDeepLinkDetail>) => void>();
    const eventListener = (event: Event) => listener(event as CustomEvent<PluginDeepLinkDetail>);
    window.addEventListener(PLUGIN_DEEP_LINK_EVENT, eventListener);
    requestPluginDeepLink({ pluginId: "example", path: "x", url: "u", params: {} });
    window.removeEventListener(PLUGIN_DEEP_LINK_EVENT, eventListener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].detail.pluginId).toBe("example");
  });
});
