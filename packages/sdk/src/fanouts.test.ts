import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";
import { bytesToBase64 } from "./encoding";
import { PragmaGatewayError } from "./errors";
import { FanoutsClient } from "./fanouts-client";

describe("client.fanouts", () => {
  it("is constructed on every client", () => {
    expect(client(async () => Response.json({})).fanouts).toBeInstanceOf(FanoutsClient);
  });

  it("posts create with the existing-parent union intact", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const sdk = client(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ fanout: fanout(), partial: false, failures: [] });
    });

    const result = await sdk.fanouts.create({
      projectId: "p1",
      parent: { kind: "existing", worktreeId: "wt-main" },
      prompt: "Implement token refresh",
      members: [{ selector: "pragma.opencode" }, { selector: "pragma.claude-code" }],
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:1/v1/rpc/fanouts");
    expect(calls[0]?.body).toEqual({
      action: "create",
      projectId: "p1",
      parent: { kind: "existing", worktreeId: "wt-main" },
      prompt: "Implement token refresh",
      members: [{ selector: "pragma.opencode" }, { selector: "pragma.claude-code" }],
    });
    expect(result.partial).toBe(false);
  });

  it("posts create with the new-parent union intact", async () => {
    let body: Record<string, unknown> = {};
    const sdk = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ fanout: fanout(), partial: false, failures: [] });
    });

    await sdk.fanouts.create({
      projectId: "p1",
      parent: {
        kind: "new",
        sourceWorktreeId: "wt-main",
        branch: "fanout/token-refresh",
        title: "Token refresh candidates",
      },
      prompt: "go",
      members: [{ selector: "a" }, { selector: "b" }],
    });

    expect(body.parent).toEqual({
      kind: "new",
      sourceWorktreeId: "wt-main",
      branch: "fanout/token-refresh",
      title: "Token refresh candidates",
    });
  });

  it("addresses get and mutations by fanout id or by worktree id", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const sdk = client(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ fanout: fanout(), partial: false, failures: [] });
    });

    await sdk.fanouts.get({ fanoutId: "f1" });
    await sdk.fanouts.cancel({ worktreeId: "wt-2" });
    await sdk.fanouts.retry({ fanoutId: "f1", memberId: "m-1" });

    expect(bodies[0]).toEqual({ action: "get", fanoutId: "f1" });
    expect(bodies[1]).toEqual({ action: "cancel", worktreeId: "wt-2" });
    expect(bodies[2]).toEqual({ action: "retry", fanoutId: "f1", memberId: "m-1" });
  });

  it("decodes read bytes to a Uint8Array and keeps per-target identity", async () => {
    const raw = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69]);
    const sdk = client(async () =>
      Response.json({
        fanoutId: "f1",
        targets: [
          {
            memberId: "m-1",
            worktreeId: "wt-1",
            tabId: "tab-1",
            runtimeAgentId: "opencode",
            bytes: raw.length,
            text: "hi",
            data: bytesToBase64(raw),
          },
        ],
      }),
    );

    const result = await sdk.fanouts.read({ fanoutId: "f1", all: true, lines: 100 });

    expect(result.targets[0]?.raw).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.targets[0]?.raw ?? [])).toEqual(Array.from(raw));
    expect(result.targets[0]?.memberId).toBe("m-1");
    expect(result.targets[0]?.runtimeAgentId).toBe("opencode");
    expect(result.targets[0]).not.toHaveProperty("data");
  });

  it("returns one delivery receipt per member from send", async () => {
    let body: Record<string, unknown> = {};
    const sdk = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        fanoutId: "f1",
        messageId: "msg-1",
        receipts: [
          {
            memberId: "m-1",
            worktreeId: "wt-1",
            tabId: "tab-1",
            runtimeAgentId: "opencode",
            messageId: "msg-1",
            state: "delivered",
          },
          {
            memberId: "m-2",
            worktreeId: "wt-2",
            tabId: "tab-2",
            runtimeAgentId: "claude-code",
            messageId: "msg-1",
            state: "timedOut",
          },
        ],
      });
    });

    const result = await sdk.fanouts.send({
      fanoutId: "f1",
      target: { kind: "all" },
      message: "Also include migration docs",
      messageId: "msg-1",
    });

    expect(body.action).toBe("send");
    expect(body.target).toEqual({ kind: "all" });
    expect(result.receipts.map((receipt) => receipt.state)).toEqual(["delivered", "timedOut"]);
    expect(result.receipts[1]?.tabId).toBe("tab-2");
  });

  it("posts pick without inventing a confirmation flag", async () => {
    let body: Record<string, unknown> = {};
    const sdk = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        fanout: fanout(),
        stage: "completed",
        winningMemberId: "m-1",
        promotedScratchpads: [".pragma/scratchpads/plan.mdx"],
        deletedWorktreeIds: ["wt-1", "wt-2"],
        survivingWorktreeIds: [],
        failures: [],
      });
    });

    const result = await sdk.fanouts.pick({ fanoutId: "f1", memberId: "m-1" });

    expect(body).toEqual({ action: "pick", fanoutId: "f1", memberId: "m-1" });
    expect(result.stage).toBe("completed");
    expect(result.deletedWorktreeIds).toHaveLength(2);
  });

  it("preserves the gateway code and the fanout failure details on an error", async () => {
    const sdk = client(async () =>
      Response.json(
        {
          code: "staleWrite",
          message: "this worktree already has an active fanout",
          details: {
            code: "activeFanoutExists",
            message: "this worktree already has an active fanout",
            memberId: null,
          },
        },
        { status: 409 },
      ),
    );

    const error = await sdk.fanouts
      .create({
        projectId: "p1",
        parent: { kind: "existing", worktreeId: "wt-main" },
        prompt: "go",
        members: [{ selector: "a" }, { selector: "b" }],
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PragmaGatewayError);
    const gatewayError = error as PragmaGatewayError;
    expect(gatewayError.code).toBe("staleWrite");
    expect(gatewayError.httpStatus).toBe(409);
    expect(gatewayError.details).toMatchObject({ code: "activeFanoutExists" });
  });

  it("narrows snapshot then delta events and ignores keepalive lines", async () => {
    const lines = [
      JSON.stringify({ type: "snapshot", subscription: "fanouts", payload: { fanouts: [] } }),
      JSON.stringify({ type: "ready" }),
      JSON.stringify({
        type: "delta",
        subscription: "fanouts",
        payload: { fanouts: [fanout()] },
      }),
    ].join("\n");
    const sdk = client(async () => new Response(`${lines}\n`));

    const events = [];
    for await (const event of sdk.fanouts.subscribe()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["snapshot", "delta"]);
    expect(events[1]?.payload.fanouts[0]?.id).toBe("f1");
  });

  it("filters a subscription to one fanout", async () => {
    const line = JSON.stringify({
      type: "delta",
      subscription: "fanouts",
      payload: { fanouts: [fanout(), { ...fanout(), id: "f2" }] },
    });
    const sdk = client(async () => new Response(`${line}\n`));

    const events = [];
    for await (const event of sdk.fanouts.subscribe({ fanoutId: "f2" })) {
      events.push(event);
    }

    expect(events[0]?.payload.fanouts.map((entry) => entry.id)).toEqual(["f2"]);
  });

  it("aborts a subscription through its signal", async () => {
    const controller = new AbortController();
    const sdk = client(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("");
    });

    controller.abort();
    const iterate = async () => {
      // The request is rejected before any event arrives.
      for await (const event of sdk.fanouts.subscribe({ signal: controller.signal })) {
        expect(event).toBeUndefined();
      }
    };

    await expect(iterate()).rejects.toThrow();
  });
});

function client(fetch: (input: string, init?: RequestInit) => Promise<Response>): PragmaClient {
  return new PragmaClient({ baseUrl: "http://127.0.0.1:1", token: "token", fetch });
}

function fanout() {
  return {
    id: "f1",
    projectId: "p1",
    parentWorktreeId: "wt-main",
    sourceWorktreeId: null,
    ownsParent: false,
    baseCommit: "aaaa1111",
    title: "Implement token refresh",
    prompt: "Implement token refresh",
    status: "active",
    winningMemberId: null,
    finalizeStage: null,
    members: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  };
}
