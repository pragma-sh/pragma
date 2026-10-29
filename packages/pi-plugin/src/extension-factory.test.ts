import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  reportCleared: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportMessage: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionId: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionName: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStarted: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStopped: vi.fn((..._args: unknown[]) => Promise.resolve({})),
}));

vi.mock("@pragma-sh/sdk", () => {
  return {
    hasPragmaEnvironment: () => true,
    reportCleared: (...args: unknown[]) => sdkMocks.reportCleared(...args),
    reportMessage: (...args: unknown[]) => sdkMocks.reportMessage(...args),
    reportSessionId: (...args: unknown[]) => sdkMocks.reportSessionId(...args),
    reportSessionName: (...args: unknown[]) => sdkMocks.reportSessionName(...args),
    reportStarted: (...args: unknown[]) => sdkMocks.reportStarted(...args),
    reportStopped: (...args: unknown[]) => sdkMocks.reportStopped(...args),
  };
});

import { createPiExtension } from "./extension-factory";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** A Pi ExtensionAPI that only records its handlers, so a test can fire them. */
function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

/** The extension context surface the factory reads: one top-level session manager. */
function fakeContext(options: {
  sessionFile: string | undefined;
  id: string;
  name?: string;
}): unknown {
  return {
    sessionManager: {
      getSessionId: () => options.id,
      getSessionFile: () => options.sessionFile,
      getSessionName: () => options.name,
    },
  };
}

function extensionFor(pi: ExtensionAPI) {
  return createPiExtension({
    agentId: "pi",
    debugEnvVar: "PRAGMA_TEST_DEBUG",
    logLabel: "@pragma-sh/pi-plugin-test",
  })(pi);
}

/** The `id` of every status-less session-id report, in order (null = a clear). */
function reportedIds(): Array<string | null> {
  return sdkMocks.reportSessionId.mock.calls.map(
    ([options]) => (options as { id: string | null }).id,
  );
}

let dir: string;
let sessionFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "pi-extension-"));
  sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "{}\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createPiExtension session identity", () => {
  it("wires the session events at the factory, not only in the reporter", () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);
    expect([...handlers.keys()]).toEqual(
      expect.arrayContaining([
        "session_start",
        "session_info_changed",
        "before_agent_start",
        "agent_end",
      ]),
    );
  });

  it("reports each identity transition, including a return to a previous session", async () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);
    const sessionStart = handlers.get("session_start");
    const beforeActivity = handlers.get("before_agent_start");

    await sessionStart?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "a" }),
    );
    await beforeActivity?.({ prompt: "first" }, fakeContext({ sessionFile, id: "a" }));
    await sessionStart?.(
      { type: "session_start", reason: "resume" },
      fakeContext({ sessionFile, id: "b" }),
    );
    await sessionStart?.(
      { type: "session_start", reason: "resume" },
      fakeContext({ sessionFile, id: "a" }),
    );

    expect(reportedIds()).toEqual(["a", "b", "a"]);
    expect(sdkMocks.reportSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "pi", id: "a" }),
    );
  });

  it("keeps same-title sessions distinct by identity", async () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);
    const sessionStart = handlers.get("session_start");

    await sessionStart?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "a", name: "Deploy the release" }),
    );
    await sessionStart?.(
      { type: "session_start", reason: "resume" },
      fakeContext({ sessionFile, id: "b", name: "Deploy the release" }),
    );

    expect(reportedIds()).toEqual(["a", "b"]);
    expect(sdkMocks.reportSessionName).toHaveBeenCalledTimes(2);
  });

  it("clears a stored conversation when a switch target has no file yet, then reports it once it does", async () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);
    const sessionStart = handlers.get("session_start");
    const agentEnd = handlers.get("agent_end");
    const first = join(dir, "a.jsonl");
    writeFileSync(first, "{}\n");
    const second = join(dir, "b.jsonl");

    // Session A is persisted and reported.
    await sessionStart?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile: first, id: "a" }),
    );
    // The user switches to a brand-new session B, whose file Pi has not
    // written yet. A crash here must not restore A.
    await sessionStart?.(
      { type: "session_start", reason: "new" },
      fakeContext({ sessionFile: second, id: "b" }),
    );
    // Repeating the observation of the still-unwritten B does not re-clear.
    await agentEnd?.({ messages: [] }, fakeContext({ sessionFile: second, id: "b" }));
    expect(reportedIds()).toEqual(["a", null]);

    // B's first assistant message is written, so its id becomes resumable.
    writeFileSync(second, "{}\n");
    await agentEnd?.({ messages: [] }, fakeContext({ sessionFile: second, id: "b" }));
    expect(reportedIds()).toEqual(["a", null, "b"]);
    expect(reportedIds().at(-1)).not.toBe("a");
  });

  it("does not clear the known conversation on shutdown or a status clear", async () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);

    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "a" }),
    );
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });

    expect(reportedIds()).toEqual(["a"]);
    expect(sdkMocks.reportCleared).toHaveBeenCalled();
  });

  it("isolates a second extension's child events from the parent's identity", async () => {
    const parent = fakePi();
    extensionFor(parent.pi);
    const parentStart = parent.handlers.get("session_start");
    const parentActivity = parent.handlers.get("before_agent_start");
    await parentStart?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "parent" }),
    );

    const child = fakePi();
    extensionFor(child.pi);
    const childStart = child.handlers.get("session_start");
    await childStart?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "child" }),
    );

    // The child's transition must not invalidate the parent's last identity.
    await parentActivity?.({ prompt: "again" }, fakeContext({ sessionFile, id: "parent" }));
    expect(reportedIds()).toEqual(["parent", "child"]);
  });

  it("reports Pi's native session name on start and rename", async () => {
    const { pi, handlers } = fakePi();
    extensionFor(pi);

    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      fakeContext({ sessionFile, id: "a", name: "Native name" }),
    );
    await handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Renamed" });

    expect(
      sdkMocks.reportSessionName.mock.calls.map(([options]) => (options as { name: string }).name),
    ).toEqual(["Native name", "Renamed"]);
  });
});
