import { describe, expect, it, vi } from "vitest";
import { PragmaClient } from "./client";

describe("local computer use", () => {
  it("requires a local credential before sending a request", async () => {
    const fetch = vi.fn();
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "",
      fetch,
    });
    await expect(client.computer.apps()).rejects.toThrow("local gateway token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses local authority for computer input and the pairing token for ordinary RPCs", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "local",
      fetch,
    });
    const signal = new AbortController().signal;
    await client.computer.type({ text: "private input", element: "s1:e1" }, { signal });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:1/v1/rpc/computer",
      expect.objectContaining({
        signal,
        headers: expect.objectContaining({ authorization: "Bearer local" }),
        body: JSON.stringify({
          text: "private input",
          element: "s1:e1",
          op: "type",
          caller: { kind: "sdk" },
        }),
      }),
    );
    await client.rpc("tabs", {});
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:1/v1/rpc/tabs",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer paired" }),
      }),
    );
  });

  it("decodes screenshots and requests inline bytes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "shot", base64: "AQID" })));
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "local",
      fetch,
    });
    const shot = await client.computer.screenshot({ app: "Safari" });
    expect(shot.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(shot).not.toHaveProperty("base64");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      app: "Safari",
      base64: true,
      op: "screenshot",
      caller: { kind: "sdk" },
    });
  });

  it("scopes activity streams and ignores keepalives", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"type":"ready"}\n{"type":"snapshot","payload":{"sessions":[]}}\n'),
      );
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "local",
      fetch,
    });
    const events = [];
    for await (const event of client.computer.activity()) events.push(event);
    expect(events).toEqual([{ type: "snapshot", payload: { sessions: [] } }]);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:1/v1/subscriptions/computerActivity",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer local" }),
      }),
    );
  });
});

describe("computer task errors and waits", () => {
  it("preserves typed host failures", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "conflict",
          message: "busy",
          details: {
            code: "appBusy",
            message: "The app is leased",
            retryable: true,
            hint: "Wait for the owner",
          },
        }),
        { status: 409 },
      ),
    );
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "local",
      fetch,
    });
    await expect(client.computer.click({ element: "s1:e1" })).rejects.toMatchObject({
      name: "PragmaComputerError",
      code: "appBusy",
      retryable: true,
      hint: "Wait for the owner",
    });
  });
  it("aborting wait leaves the host task running", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      controller.abort(new Error("stop waiting"));
      return new Response(JSON.stringify({ id: "task", status: "running" }));
    });
    const client = new PragmaClient({
      baseUrl: "http://localhost:1",
      token: "paired",
      localToken: "local",
      fetch,
    });
    await expect(client.computer.wait("task", { signal: controller.signal })).rejects.toThrow(
      "stop waiting",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).op).toBe("task");
  });
});
