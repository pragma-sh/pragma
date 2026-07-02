import { describe, expect, it } from "vitest";

import { PragmaGatewayError } from "./errors";
import { Transport, urlFor } from "./transport";

describe("transport", () => {
  it("builds URLs", () => {
    expect(urlFor("http://127.0.0.1:1/", "/v1/health")).toBe("http://127.0.0.1:1/v1/health");
  });

  it("sends bearer token and JSON body", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const transport = new Transport({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return Response.json({ ok: true });
      },
    });

    await transport.request("/v1/rpc/filesystem", { body: { op: "pathExists" } });

    const call = calls[0];
    if (!call?.init) {
      throw new Error("expected transport fetch to be called with request options");
    }
    expect(call.input).toBe("http://127.0.0.1:1234/v1/rpc/filesystem");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(call.init.body).toBe(JSON.stringify({ op: "pathExists" }));
  });

  it("narrows gateway errors", async () => {
    const transport = new Transport({
      baseUrl: "http://127.0.0.1:1234",
      token: "secret",
      fetch: async () => Response.json({ code: "notFound", message: "missing" }, { status: 404 }),
    });

    await expect(transport.request("/missing")).rejects.toMatchObject({
      code: "notFound",
      httpStatus: 404,
    } satisfies Partial<PragmaGatewayError>);
  });
});
