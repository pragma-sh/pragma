import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

describe("agents.catalog", () => {
  it("GETs the catalog route", async () => {
    let url: string | undefined;
    let method: string | undefined;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        url = String(target);
        method = init?.method ?? "GET";
        return new Response(
          JSON.stringify({ agents: [{ id: "a", name: "A", pluginId: "p", models: [] }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const catalog = await client.agents.catalog();

    expect(url).toBe("http://127.0.0.1:1/v1/agents/catalog");
    expect(method).toBe("GET");
    expect(catalog.agents[0]?.id).toBe("a");
  });
});

describe("assets", () => {
  it("fetches raw bytes + mime by hash", async () => {
    const hash = "a".repeat(64);
    let url: string | undefined;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target) => {
        url = String(target);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        });
      },
    });

    const asset = await client.assets.fetch(hash);

    expect(url).toBe(`http://127.0.0.1:1/v1/assets/${hash}`);
    expect(asset.mime).toBe("image/svg+xml");
    expect([...asset.bytes]).toEqual([1, 2, 3]);
  });

  it("builds a data URI", async () => {
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () =>
        new Response(new Uint8Array([104, 105]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    });

    const uri = await client.assets.toDataUri("b".repeat(64));

    expect(uri).toBe("data:image/png;base64,aGk=");
  });
});
