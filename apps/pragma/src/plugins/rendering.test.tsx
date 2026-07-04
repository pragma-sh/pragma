import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import { setPluginRuntimeProject, setPluginRuntimeSdk } from "./host-hooks";
import { clearPlugins, setPluginsForScope, type PluginRecord } from "./registry";
import {
  RenderPluginContribution,
  usePluginSidebarCards,
  usePluginSidebarTabs,
  usePluginTopperItems,
} from "./rendering";

function record(overrides: Partial<PluginRecord> & { pluginId: string }): PluginRecord {
  return {
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    ...overrides,
  };
}

function Probe({ activeProjectId }: { activeProjectId: string | null }) {
  const tabs = usePluginSidebarTabs(activeProjectId);
  return <div>{tabs.map((tab) => tab.contribution.title).join(",")}</div>;
}

function TopperProbe({ align }: { align?: "left" | "right" }) {
  const items = usePluginTopperItems(null, align);
  return <div>{items.map((item) => item.key).join(",")}</div>;
}

function CardsProbe() {
  const cards = usePluginSidebarCards(null);
  return <div>{cards.map((card) => card.contribution.title).join(",")}</div>;
}

function BrokenContribution(): never {
  throw new Error("boom");
}

afterEach(() => {
  clearPlugins();
  setPluginRuntimeProject(null);
  setPluginRuntimeSdk(null);
  vi.restoreAllMocks();
});

describe("plugin rendering helpers", () => {
  it("returns loaded sidebar tabs visible to the active project", () => {
    const globalDefinition = {
      name: "global",
      ui: { sidebarTabs: [{ id: "g", title: "Global", component: () => null }] },
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    const projectDefinition = {
      name: "project",
      ui: { sidebarTabs: [{ id: "p", title: "Project", component: () => null }] },
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    setPluginsForScope("global", null, [
      record({ pluginId: "global", definition: globalDefinition }),
    ]);
    setPluginsForScope("project", "/p/one", [
      record({
        pluginId: "project",
        scope: "project",
        projectId: "one",
        projectPath: "/p/one",
        definition: projectDefinition,
      }),
    ]);

    render(<Probe activeProjectId="one" />);

    expect(screen.getByText("Global,Project")).toBeInTheDocument();
  });

  it("holds back guarded sidebar tabs until the SDK bridge is available", () => {
    const definition = {
      name: "guarded",
      ui: {
        sidebarTabs: [
          { id: "always", title: "Always", component: () => null },
          { id: "guarded", title: "Guarded", component: () => null, when: () => true },
        ],
      },
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    setPluginsForScope("global", null, [record({ pluginId: "guarded", definition })]);

    const { rerender } = render(<Probe activeProjectId={null} />);
    expect(screen.getByText("Always")).toBeInTheDocument();

    setPluginRuntimeSdk({} as PragmaClient);
    rerender(<Probe activeProjectId={null} />);

    expect(screen.getByText("Always,Guarded")).toBeInTheDocument();
  });

  it("returns topper items filtered by alignment", () => {
    const definition = {
      name: "topper",
      ui: {
        topper: [
          { align: "left", component: () => null },
          { align: "right", component: () => null },
        ],
      },
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    setPluginsForScope("global", null, [record({ pluginId: "topper", definition })]);

    render(<TopperProbe align="right" />);

    expect(screen.getByText("topper:1")).toBeInTheDocument();
  });

  it("returns sidebar cards", () => {
    const definition = {
      name: "cards",
      ui: { sidebarCards: [{ title: "Card", component: () => null }] },
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    setPluginsForScope("global", null, [record({ pluginId: "cards", definition })]);

    render(<CardsProbe />);

    expect(screen.getByText("Card")).toBeInTheDocument();
  });

  it("renders plugin component crashes inside the plugin boundary", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <RenderPluginContribution
        component={BrokenContribution}
        config={{}}
        pluginId="broken-plugin"
        resetKey="broken-plugin:tab"
      />,
    );

    expect(screen.getByText('Plugin "broken-plugin" crashed.')).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
