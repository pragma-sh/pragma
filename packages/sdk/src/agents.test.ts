import { describe, expect, it } from "vitest";

import { reportAttention, reportStarted } from "./agents-client";
import { PragmaClient } from "./client";
import { PRAGMA_ENV_KEYS } from "./env";

/** A Response streaming `text` as a single NDJSON chunk, then closing. */
function ndjsonResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("agents", () => {
  it("no-ops outside Pragma", async () => {
    await expect(reportStarted({ agent: "opencode", env: {} })).resolves.toBeUndefined();
  });

  it("builds report payload", async () => {
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await reportStarted({
      agent: "opencode",
      client,
      env: {
        [PRAGMA_ENV_KEYS.tabId]: "tab",
        [PRAGMA_ENV_KEYS.worktreeId]: "worktree",
      },
    });

    expect(JSON.parse(body)).toEqual({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      status: "running",
      attentionKind: null,
    });
  });

  it("uses gateway credentials from custom env for fallback reports", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
      await reportStarted({
        agent: "opencode",
        env: {
          [PRAGMA_ENV_KEYS.gatewayUrl]: "http://127.0.0.1:1234",
          [PRAGMA_ENV_KEYS.gatewayToken]: "token-from-env",
          [PRAGMA_ENV_KEYS.tabId]: "tab",
          [PRAGMA_ENV_KEYS.worktreeId]: "worktree",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const call = calls[0];
    if (!call?.init) {
      throw new Error("expected fallback report to call fetch");
    }
    expect(call.input).toBe("http://127.0.0.1:1234/v1/agents/reports");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      "Bearer token-from-env",
    );
  });

  it("carries the command and requestId on a command attention report", async () => {
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await reportAttention({
      agent: "cursor",
      client,
      kind: "command",
      command: "rm -rf ./dist",
      requestId: "req-1",
      env: { [PRAGMA_ENV_KEYS.tabId]: "tab", [PRAGMA_ENV_KEYS.worktreeId]: "worktree" },
    });

    expect(JSON.parse(body)).toEqual({
      agent: "cursor",
      worktreeId: "worktree",
      tabId: "tab",
      status: "attention",
      attentionKind: "command",
      command: "rm -rf ./dist",
      requestId: "req-1",
    });
  });

  it("posts a decision to the decisions route", async () => {
    let input: string | URL | Request | undefined;
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        input = target;
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await client.agents.reportDecision({
      agent: "claude-code",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-1",
      approved: true,
    });

    expect(input).toBe("http://127.0.0.1:1/v1/agents/decisions");
    expect(JSON.parse(body)).toEqual({
      agent: "claude-code",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-1",
      approved: true,
    });
  });

  it("awaitDecision resolves the verdict for a matching requestId", async () => {
    const line = `${JSON.stringify({
      type: "agentDecision",
      decision: {
        agent: "claude-code",
        worktreeId: "worktree",
        tabId: "tab",
        requestId: "req-1",
        approved: true,
      },
    })}\n`;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () => ndjsonResponse(line),
    });

    await expect(
      client.agents.awaitDecision({ agent: "claude-code", requestId: "req-1" }),
    ).resolves.toBe(true);
  });

  it("awaitDecision returns null when the stream ends without a match", async () => {
    const other = `${JSON.stringify({
      type: "agentDecision",
      decision: {
        agent: "claude-code",
        worktreeId: "worktree",
        tabId: "tab",
        requestId: "other",
        approved: false,
      },
    })}\n`;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () => ndjsonResponse(other),
    });

    await expect(
      client.agents.awaitDecision({ agent: "claude-code", requestId: "req-1" }),
    ).resolves.toBeNull();
  });

  it("posts an answer to the answers route", async () => {
    let input: string | URL | Request | undefined;
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        input = target;
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await client.agents.reportAnswer({
      agent: "claude-code",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-1",
      answer: "option B",
      dismissed: false,
    });

    expect(input).toBe("http://127.0.0.1:1/v1/agents/answers");
    expect(JSON.parse(body)).toEqual({
      agent: "claude-code",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-1",
      answer: "option B",
      dismissed: false,
    });
  });

  it("awaitAnswer resolves the reply text for a matching requestId", async () => {
    const line = `${JSON.stringify({
      type: "agentAnswer",
      answer: {
        agent: "claude-code",
        worktreeId: "worktree",
        tabId: "tab",
        requestId: "req-1",
        answer: "option B",
        dismissed: false,
      },
    })}\n`;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () => ndjsonResponse(line),
    });

    await expect(
      client.agents.awaitAnswer({ agent: "claude-code", requestId: "req-1" }),
    ).resolves.toBe("option B");
  });

  it("awaitAnswer returns null for a dismissed reply", async () => {
    const line = `${JSON.stringify({
      type: "agentAnswer",
      answer: {
        agent: "claude-code",
        worktreeId: "worktree",
        tabId: "tab",
        requestId: "req-1",
        dismissed: true,
      },
    })}\n`;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () => ndjsonResponse(line),
    });

    await expect(
      client.agents.awaitAnswer({ agent: "claude-code", requestId: "req-1" }),
    ).resolves.toBeNull();
  });

  it("posts an interjection to the inputs route", async () => {
    let input: string | URL | Request | undefined;
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        input = target;
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await client.agents.reportInput({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      text: "focus on the tests",
    });

    expect(input).toBe("http://127.0.0.1:1/v1/agents/inputs");
    expect(JSON.parse(body)).toEqual({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      text: "focus on the tests",
    });
  });

  it("posts an interrupt to the interrupts route", async () => {
    let input: string | URL | Request | undefined;
    let body = "";
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        input = target;
        body = String(init?.body);
        return new Response(null, { status: 202 });
      },
    });

    await client.agents.reportInterrupt({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-9",
    });

    expect(input).toBe("http://127.0.0.1:1/v1/agents/interrupts");
    expect(JSON.parse(body)).toEqual({
      agent: "opencode",
      worktreeId: "worktree",
      tabId: "tab",
      requestId: "req-9",
    });
  });
});

describe("agents connect", () => {
  it("sends the initial prompt as an interjection before returning", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        if (init?.method === "POST") {
          posts.push({ url: String(target), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 202 });
        }
        return ndjsonResponse("");
      },
    });

    await client.agents.connect({
      agent: "opencode",
      tabId: "tab",
      worktreeId: "worktree",
      prompt: "start here",
    });

    expect(posts).toEqual([
      {
        url: "http://127.0.0.1:1/v1/agents/inputs",
        body: { agent: "opencode", worktreeId: "worktree", tabId: "tab", text: "start here" },
      },
    ]);
  });

  it("connects to an existing session with no prompt (no interjection sent)", async () => {
    let posted = false;
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (_target, init) => {
        if (init?.method === "POST") {
          posted = true;
          return new Response(null, { status: 202 });
        }
        return ndjsonResponse("");
      },
    });

    const connection = await client.agents.connect({
      agent: "opencode",
      tabId: "tab",
      worktreeId: "worktree",
    });
    connection.close();

    expect(posted).toBe(false);
  });

  it("yields only events routed to the connected agent + tab", async () => {
    const mine = JSON.stringify({
      type: "agentMessage",
      message: { agent: "opencode", worktreeId: "worktree", tabId: "tab", id: "m1" },
    });
    const otherTab = JSON.stringify({
      type: "agentMessage",
      message: { agent: "opencode", worktreeId: "worktree", tabId: "other", id: "m2" },
    });
    const otherAgent = JSON.stringify({
      type: "agentInput",
      input: { agent: "cursor", worktreeId: "worktree", tabId: "tab", text: "nope" },
    });
    const interruptOtherTab = JSON.stringify({
      type: "agentInterrupt",
      interrupt: { agent: "opencode", worktreeId: "worktree", tabId: "other" },
    });
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async () =>
        ndjsonResponse(`${mine}\n${otherTab}\n${otherAgent}\n${interruptOtherTab}\n`),
    });

    const connection = await client.agents.connect({
      agent: "opencode",
      tabId: "tab",
      worktreeId: "worktree",
    });
    const seen: string[] = [];
    for await (const event of connection) {
      if (event.type === "agentMessage") {
        seen.push(event.message.id);
      } else {
        seen.push(`unexpected:${event.type}`);
      }
    }

    expect(seen).toEqual(["m1"]);
  });

  it("send/answer/decide post to the right routes with the connect routing keys", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new PragmaClient({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      fetch: async (target, init) => {
        if (init?.method === "POST") {
          posts.push({ url: String(target), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 202 });
        }
        return ndjsonResponse("");
      },
    });

    const connection = await client.agents.connect({
      agent: "opencode",
      tabId: "tab",
      worktreeId: "worktree",
    });
    await connection.send("interject");
    await connection.answer("req-1", "reply");
    await connection.answer("req-2", null);
    await connection.decide("req-3", false);
    await connection.interrupt("req-4");
    connection.close();

    expect(posts).toEqual([
      {
        url: "http://127.0.0.1:1/v1/agents/inputs",
        body: { agent: "opencode", worktreeId: "worktree", tabId: "tab", text: "interject" },
      },
      {
        url: "http://127.0.0.1:1/v1/agents/answers",
        body: {
          agent: "opencode",
          worktreeId: "worktree",
          tabId: "tab",
          requestId: "req-1",
          dismissed: false,
          answer: "reply",
        },
      },
      {
        url: "http://127.0.0.1:1/v1/agents/answers",
        body: {
          agent: "opencode",
          worktreeId: "worktree",
          tabId: "tab",
          requestId: "req-2",
          dismissed: true,
        },
      },
      {
        url: "http://127.0.0.1:1/v1/agents/decisions",
        body: {
          agent: "opencode",
          worktreeId: "worktree",
          tabId: "tab",
          requestId: "req-3",
          approved: false,
        },
      },
      {
        url: "http://127.0.0.1:1/v1/agents/interrupts",
        body: {
          agent: "opencode",
          worktreeId: "worktree",
          tabId: "tab",
          requestId: "req-4",
        },
      },
    ]);
  });
});
