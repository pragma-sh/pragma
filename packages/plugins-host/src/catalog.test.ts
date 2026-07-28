import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PluginContext, PluginDefinition } from "@pragma/plugin";

import {
  ICON_MAX_BYTES,
  assembleCatalog,
  assembleWatchers,
  hashIcon,
  mimeForIcon,
  resolveModels,
  type ResolvedPlugin,
} from "./catalog";

const ctx = {} as PluginContext;

function tempIcon(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pragma-icons-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("mimeForIcon", () => {
  it("maps known extensions", () => {
    expect(mimeForIcon("/x/a.svg")).toBe("image/svg+xml");
    expect(mimeForIcon("/x/a.PNG")).toBe("image/png");
    expect(mimeForIcon("/x/a.unknown")).toBe("application/octet-stream");
  });
});

describe("hashIcon", () => {
  it("hashes an icon and reports its mime", () => {
    const path = tempIcon("icon.svg", "<svg/>");
    const asset = hashIcon(path);
    expect(asset.mime).toBe("image/svg+xml");
    expect(asset.hash).toMatch(/^[0-9a-f]{64}$/);
    // Same content, same hash.
    expect(hashIcon(tempIcon("other.svg", "<svg/>")).hash).toBe(asset.hash);
  });

  it("rejects an icon over the cap", () => {
    const path = tempIcon("big.png", "x".repeat(ICON_MAX_BYTES + 1));
    expect(() => hashIcon(path)).toThrow(/cap/);
  });
});

describe("resolveModels", () => {
  it("returns a static model array", async () => {
    expect(await resolveModels({ models: [{ id: "m", name: "M" }] } as never, ctx)).toEqual([
      { id: "m", name: "M" },
    ]);
  });

  it("awaits an async model provider", async () => {
    const agent = { models: async () => [{ id: "async", name: "Async" }] } as never;
    expect(await resolveModels(agent, ctx)).toEqual([{ id: "async", name: "Async" }]);
  });
});

/** An agent definition whose model provider varies per test (flaky-provider fixtures). */
function flakyAgent(models: unknown, iconPath?: string): Record<string, unknown> {
  return {
    id: "flaky",
    name: "Flaky",
    ...(iconPath ? { iconPath } : {}),
    launch: { command: ["flaky"] },
    models,
    args: { model: (id: string) => ["--model", id] },
  };
}

function plugin(pluginId: string, definition: unknown, dir = "/plugins/one"): ResolvedPlugin {
  return {
    pluginId,
    scope: "bundled",
    root: "/plugins",
    dir,
    mainPath: join(dir, "plugin.mjs"),
    config: undefined,
    definition: definition as PluginDefinition,
  };
}

describe("assembleCatalog", () => {
  it("assembles agents with icon assets and skips failures", async () => {
    const iconPath = tempIcon("agent.svg", "<svg>a</svg>");
    const plugins: ResolvedPlugin[] = [
      plugin("p.one", {
        agents: [
          {
            id: "good",
            name: "Good",
            iconPath,
            launch: { command: ["good"] },
            excludeFeatures: ["questions", "subagents"],
            models: [{ id: "m", name: "M" }],
            args: { model: (id: string) => ["--model", id] },
          },
          {
            id: "bad",
            name: "Bad",
            iconPath: "/does/not/exist.svg",
            models: [],
          },
        ],
      }),
    ];
    const errors: string[] = [];
    const { catalog, assets } = await assembleCatalog(plugins, ctx, (_p, agentId) =>
      errors.push(agentId),
    );

    expect(errors).toEqual(["bad"]);
    expect(catalog.agents).toHaveLength(1);
    const [agent] = catalog.agents;
    expect(agent?.id).toBe("p.one.good");
    expect(agent?.pluginId).toBe("p.one");
    expect(agent?.excludeFeatures).toEqual(["questions", "subagents"]);
    expect(agent?.launch.commands).toEqual([
      { modelId: null, reasoningId: null, command: ["good"] },
      { modelId: "m", reasoningId: null, command: ["good", "--model", "m"] },
    ]);
    expect(agent?.icon?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(assets)).toEqual([agent?.icon?.hash]);
    expect(assets[agent!.icon!.hash]?.path).toBe(iconPath);
  });

  it("resolves a plugin-dir-relative icon path against the plugin directory", async () => {
    const iconPath = tempIcon("rel.svg", "<svg>rel</svg>");
    const dir = join(iconPath, "..");
    const plugins: ResolvedPlugin[] = [
      plugin(
        "p.rel",
        {
          agents: [
            {
              id: "rel",
              name: "Rel",
              iconPath: "rel.svg",
              launch: { command: ["rel"] },
              models: [],
              args: { model: () => [] },
            },
          ],
        },
        dir,
      ),
    ];
    const { catalog, assets } = await assembleCatalog(plugins, ctx);
    const hash = catalog.agents[0]?.icon?.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(assets[hash!]?.path).toBe(join(dir, "rel.svg"));
  });

  it("falls back to the last-good entry when a model provider throws", async () => {
    const iconPath = tempIcon("flaky.svg", "<svg>flaky</svg>");
    const dir = join(iconPath, "..");
    const good = await assembleCatalog(
      [plugin("p.one", { agents: [flakyAgent([{ id: "m", name: "M" }], "flaky.svg")] }, dir)],
      ctx,
    );
    expect(good.catalog.agents).toHaveLength(1);

    const errors: string[] = [];
    const flaky = await assembleCatalog(
      [
        plugin(
          "p.one",
          {
            agents: [
              flakyAgent(async () => {
                throw new Error("exec failed");
              }, "flaky.svg"),
            ],
          },
          dir,
        ),
      ],
      ctx,
      (_p, agentId) => errors.push(agentId),
      good,
    );

    expect(errors).toEqual(["flaky"]);
    expect(flaky.catalog.agents).toEqual(good.catalog.agents);
    // The reused entry's icon asset rides along so the gateway keeps serving it.
    const hash = good.catalog.agents[0]?.icon?.hash;
    expect(flaky.assets[hash!]?.path).toBe(join(dir, "flaky.svg"));
  });

  it("falls back to the last-good entry when a model provider returns no models", async () => {
    const good = await assembleCatalog(
      [plugin("p.one", { agents: [flakyAgent([{ id: "m", name: "M" }])] })],
      ctx,
    );

    const errors: string[] = [];
    const empty = await assembleCatalog(
      [plugin("p.one", { agents: [flakyAgent(async () => [])] })],
      ctx,
      (_p, agentId) => errors.push(agentId),
      good,
    );

    expect(errors).toEqual(["flaky"]);
    expect(empty.catalog.agents).toEqual(good.catalog.agents);
  });

  it("still skips a failing agent when no last-good entry exists", async () => {
    const plugins: ResolvedPlugin[] = [
      plugin("p.one", {
        agents: [
          {
            id: "broken",
            name: "Broken",
            launch: { command: ["broken"] },
            models: async () => {
              throw new Error("exec failed");
            },
            args: { model: () => [] },
          },
        ],
      }),
    ];
    const { catalog } = await assembleCatalog(plugins, ctx, () => {}, {
      catalog: { agents: [] },
      assets: {},
    });
    expect(catalog.agents).toEqual([]);
  });

  it("resolves model providers concurrently while preserving agent order", async () => {
    let releaseFirst: (() => void) | undefined;
    let secondStarted = false;
    const plugins: ResolvedPlugin[] = [
      plugin("p.one", {
        agents: [
          {
            id: "first",
            name: "First",
            launch: { command: ["first"] },
            models: () =>
              new Promise((resolve) => {
                releaseFirst = () => resolve([]);
              }),
          },
          {
            id: "second",
            name: "Second",
            launch: { command: ["second"] },
            models: async () => {
              secondStarted = true;
              return [];
            },
          },
        ],
      }),
    ];

    const result = assembleCatalog(plugins, ctx);

    expect(secondStarted).toBe(true);
    releaseFirst?.();
    expect((await result).catalog.agents.map((agent) => agent.id)).toEqual([
      "p.one.first",
      "p.one.second",
    ]);
  });
});

describe("assembleWatchers", () => {
  it("flattens plugin watcher declarations with their bundle path and config", () => {
    const plugins: ResolvedPlugin[] = [
      {
        ...plugin("p.one", { watchers: [{ agent: "one", watch: () => {} }] }),
        config: { approveKeys: "y" },
      },
      plugin("p.none", { agents: [] }),
    ];
    expect(assembleWatchers(plugins)).toEqual([
      {
        pluginId: "p.one",
        agentId: "p.one.one",
        watcherAgent: "one",
        // Built with `join`, like the `plugin()` helper: a hardcoded
        // "/plugins/one/plugin.mjs" is `\plugins\one\plugin.mjs` on Windows.
        mainPath: join("/plugins/one", "plugin.mjs"),
        config: { approveKeys: "y" },
      },
    ]);
  });
});
