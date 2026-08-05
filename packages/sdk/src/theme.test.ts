import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

describe("theme namespace", () => {
  it("fetches the global theme", async () => {
    const requested: string[] = [];
    const client = clientWithFetch(async (input) => {
      requested.push(input);
      return Response.json({ colors: { dark: { background: "oklch(0.1 0 0)" } }, sources: {} });
    });

    const theme = await client.theme.get();

    expect(requested).toEqual(["http://127.0.0.1:1/v1/theme"]);
    expect(theme.colors.dark?.background).toBe("oklch(0.1 0 0)");
  });

  it("scopes the request to a project root", async () => {
    let requested = "";
    const client = clientWithFetch(async (input) => {
      requested = input;
      return Response.json({ colors: {}, sources: { global: false, project: false } });
    });

    await client.theme.get({ root: "/Users/dev/my repo" });

    expect(requested).toBe("http://127.0.0.1:1/v1/theme?root=%2FUsers%2Fdev%2Fmy%20repo");
  });
});

function clientWithFetch(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}
