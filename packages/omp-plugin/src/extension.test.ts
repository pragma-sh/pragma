import { describe, expect, it } from "vitest";

import type { PiReporter } from "@pragma-sh/pi-plugin/reporter";

import type { OmpFormModules } from "./ask-form";
import { createOmpExtension } from "./extension";
import type { OmpAgentIdentity, OmpExtensionAPI, OmpExtensionContext } from "./omp-api";
import { createSubagentTracker } from "./subagents";

type Handler = (event: unknown, ctx: OmpExtensionContext) => unknown;

/** A stand-in for omp's parser: one radio field per `name=label` pair. */
const formModules: OmpFormModules = {
  parseHtmlForm: (html) => {
    if (html === "broken") throw new Error("unparseable");
    return {
      fields: [
        {
          kind: "choice",
          name: "db",
          options: [
            { label: [{ text: "Postgres" }], disabled: false },
            { label: [{ text: "MySQL" }], disabled: true },
            { label: [{ text: " SQLite " }], disabled: false },
          ],
        },
      ],
    };
  },
  fieldQuestions: (form) => new Map(form.fields.map((field) => [field, "Pick a db"])),
};

function harness() {
  const events: string[] = [];
  const reporter: PiReporter = {
    started: async () => void events.push("started"),
    stopped: async () => void events.push("stopped"),
    cleared: async () => void events.push("cleared"),
    message: async (message) =>
      void events.push(`message:${message.role}:${message.subAgentsActive}`),
    sessionName: async (name) => void events.push(`name:${name}`),
    sessionId: async (id) => void events.push(`id:${id}`),
  };
  const tracker = createSubagentTracker();
  const files = new Set<string>();
  const session = { id: "s-1", name: undefined as string | undefined };
  // Each `bind` is one omp factory binding: the main session or a subagent.
  const bind = () => {
    const handlers = new Map<string, Handler[]>();
    const api = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as unknown as OmpExtensionAPI;
    createOmpExtension({
      reporter,
      tracker,
      fileExists: (path) => files.has(path),
      askAttention: async (questions, requestId) =>
        void events.push(`ask:${requestId}:${JSON.stringify(questions)}`),
      formModules: async () => formModules,
    })(api);
    return async (event: string, payload: unknown, agent: OmpAgentIdentity) => {
      const ctx: OmpExtensionContext = {
        agent,
        sessionManager: {
          getSessionId: () => session.id,
          getSessionFile: () => `/sessions/${session.id}.jsonl`,
          getSessionName: () => session.name,
        },
      };
      // omp runs one event's handlers in order; keep them sequential.
      // oxlint-disable-next-line no-await-in-loop
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
      // Let fire-and-forget reports settle on the serialized queue.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
  };
  return { events, files, session, bind, tracker };
}

const MAIN: OmpAgentIdentity = { kind: "main", id: "Main" };
const sub = (id: string): OmpAgentIdentity => ({ kind: "sub", id, parentId: "Main" });
const done = { messages: [{ role: "assistant", stopReason: "stop" }] };

describe("omp extension", () => {
  it("reports a normal turn as started then stopped, and names from the prompt", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("session_start", {}, MAIN);
    await main("before_agent_start", { reason: "prompt", prompt: "Fix the build\nmore" }, MAIN);
    await main("agent_start", {}, MAIN);
    await main("agent_end", done, MAIN);
    expect(events).toEqual([
      "cleared",
      "id:null",
      "name:Fix the build",
      "message:user:0",
      "started",
      "stopped",
    ]);
  });

  it("clears instead of stopping an aborted turn", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("agent_start", {}, MAIN);
    await main("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, MAIN);
    expect(events.slice(-1)).toEqual(["cleared"]);
    expect(events).not.toContain("stopped");
  });

  it("keeps running across a scheduled continuation", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("agent_start", {}, MAIN);
    await main("agent_end", { ...done, willContinue: true }, MAIN);
    expect(events).not.toContain("stopped");
    await main("agent_start", {}, MAIN);
    await main("agent_end", done, MAIN);
    expect(events.filter((event) => event === "started")).toHaveLength(1);
    expect(events.slice(-1)).toEqual(["stopped"]);
  });

  it("never reports status from a subagent binding, even on its load", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("agent_start", {}, MAIN);
    const child = bind();
    await child("session_start", {}, sub("0-Explore"));
    await child("before_agent_start", { reason: "prompt", prompt: "explore" }, sub("0-Explore"));
    await child("session_shutdown", {}, sub("0-Explore"));
    expect(events).toEqual(["started"]);
  });

  it("counts running subagents and holds done until the last one settles", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("session_start", {}, MAIN);
    await main("agent_start", {}, MAIN);
    const a = bind();
    const b = bind();
    await a("agent_start", {}, sub("0-A"));
    await b("agent_start", {}, sub("1-B"));
    await main("agent_end", done, MAIN);
    expect(events).not.toContain("stopped");
    await a("agent_end", done, sub("0-A"));
    expect(events).not.toContain("stopped");
    await b("agent_end", done, sub("1-B"));
    expect(events.filter((event) => event.startsWith("message:system"))).toEqual([
      "message:system:1",
      "message:system:2",
      "message:system:1",
      "message:system:0",
    ]);
    expect(events.slice(-1)).toEqual(["stopped"]);
  });

  it("reports the resumable id once the lazy session file exists", async () => {
    const { events, files, bind } = harness();
    const main = bind();
    await main("session_start", {}, MAIN);
    await main("agent_start", {}, MAIN);
    files.add("/sessions/s-1.jsonl");
    await main("agent_end", done, MAIN);
    expect(events).toContain("id:s-1");
  });

  it("prefers omp's generated title over the prompt fallback", async () => {
    const { events, session, bind } = harness();
    const main = bind();
    await main("session_start", {}, MAIN);
    await main("before_agent_start", { reason: "prompt", prompt: "do it" }, MAIN);
    await main("agent_start", {}, MAIN);
    session.name = "🔧 BLD: Fix the build";
    await main("agent_end", done, MAIN);
    await main("agent_start", {}, MAIN);
    await main("agent_end", done, MAIN);
    expect(events.filter((event) => event.startsWith("name:"))).toEqual([
      "name:do it",
      "name:🔧 BLD: Fix the build",
    ]);
  });

  it("reports an ask form as question attention, then returns to running", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("agent_start", {}, MAIN);
    await main(
      "tool_execution_start",
      { toolCallId: "call-1", toolName: "ask", args: { html: "<form>" } },
      MAIN,
    );
    await main(
      "tool_execution_end",
      { toolCallId: "call-1", toolName: "ask", isError: false },
      MAIN,
    );
    expect(events).toEqual([
      "started",
      `ask:call-1:${JSON.stringify([{ question: "Pick a db", options: [{ label: "Postgres" }, { label: "SQLite" }] }])}`,
      "started",
    ]);
  });

  it("still raises attention when the form cannot be parsed", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("agent_start", {}, MAIN);
    await main(
      "tool_execution_start",
      { toolCallId: "c", toolName: "ask", args: { html: "broken" } },
      MAIN,
    );
    expect(events.slice(-1)).toEqual(["ask:c:[]"]);
  });

  it("ignores other tools, subagent asks, and asks outside a turn", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main(
      "tool_execution_start",
      { toolCallId: "a", toolName: "ask", args: { html: "" } },
      MAIN,
    );
    await main("agent_start", {}, MAIN);
    await main("tool_execution_start", { toolCallId: "b", toolName: "bash", args: {} }, MAIN);
    await bind()(
      "tool_execution_start",
      { toolCallId: "c", toolName: "ask", args: {} },
      sub("0-A"),
    );
    expect(events).toEqual(["started"]);
  });

  it("ignores revive prompts and clears on shutdown", async () => {
    const { events, bind } = harness();
    const main = bind();
    await main("before_agent_start", { reason: "revive", prompt: "" }, MAIN);
    expect(events).toEqual([]);
    await main("agent_start", {}, MAIN);
    await main("session_shutdown", {}, MAIN);
    expect(events).toEqual(["started", "cleared"]);
  });
});
