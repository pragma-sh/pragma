import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma-sh/plugin";

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ selectedProjectId: null }),
}));

import { clearPlugins, setPluginsForScope } from "@/plugins/registry";
import { PluginSidebarCards } from "./PluginSidebarCards";

const count = vi.hoisted(() => {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: number) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

function installCards(sidebarCards: unknown[]): void {
  const definition = { name: "cards", ui: { sidebarCards }, __apiVersion: "1.0.0" };
  setPluginsForScope("global", null, [
    {
      pluginId: "cards",
      version: "1.0.0",
      scope: "global",
      status: "loaded",
      config: {},
      definition: definition as unknown as PluginDefinition,
    },
  ]);
}

afterEach(() => {
  cleanup();
  clearPlugins();
  count.set(0);
});

describe("PluginSidebarCards", () => {
  it("always shows an uncounted card, unbadged", () => {
    installCards([{ title: "Alerts", component: () => <p>alert body</p> }]);
    render(<PluginSidebarCards />);

    expect(screen.getByRole("button", { name: "Toggle Alerts panel" })).toBeInTheDocument();
    expect(screen.getByText("alert body")).toBeInTheDocument();
  });

  it("hides a counted card at zero and shows it, badged, once the count rises", async () => {
    const { useSyncExternalStore } = await import("react");
    installCards([
      {
        title: "Queue",
        component: () => <p>queue body</p>,
        useCount: () => useSyncExternalStore(count.subscribe, count.get),
      },
    ]);
    render(<PluginSidebarCards />);

    expect(screen.queryByRole("button", { name: "Toggle Queue panel" })).not.toBeInTheDocument();

    act(() => count.set(3));
    const toggle = await screen.findByRole("button", { name: "Toggle Queue panel" });
    expect(toggle).toHaveTextContent("3");

    act(() => count.set(0));
    expect(screen.queryByRole("button", { name: "Toggle Queue panel" })).not.toBeInTheDocument();
  });
});
