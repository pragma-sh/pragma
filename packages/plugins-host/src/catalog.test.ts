import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PluginContext, PluginDefinition } from "@pragma/plugin";

import {
  ICON_MAX_BYTES,
  assembleCatalog,
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

describe("assembleCatalog", () => {
  it("assembles agents with icon assets and skips failures", async () => {
    const iconPath = tempIcon("agent.svg", "<svg>a</svg>");
    const plugins: ResolvedPlugin[] = [
      {
        pluginId: "p.one",
        definition: {
          agents: [
            {
              id: "good",
              name: "Good",
              iconPath,
              launch: { command: ["good"] },
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
        } as unknown as PluginDefinition,
      },
    ];
    const errors: string[] = [];
    const { catalog, assets } = await assembleCatalog(plugins, ctx, (_p, agentId) =>
      errors.push(agentId),
    );

    expect(errors).toEqual(["bad"]);
    expect(catalog.agents).toHaveLength(1);
    const [agent] = catalog.agents;
    expect(agent?.id).toBe("good");
    expect(agent?.pluginId).toBe("p.one");
    expect(agent?.launch.commands).toEqual([
      { modelId: null, reasoningId: null, command: ["good"] },
      { modelId: "m", reasoningId: null, command: ["good", "--model", "m"] },
    ]);
    expect(agent?.icon?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(assets)).toEqual([agent?.icon?.hash]);
    expect(assets[agent!.icon!.hash]?.path).toBe(iconPath);
  });
});
