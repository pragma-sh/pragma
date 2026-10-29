import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  reportAttention: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportCleared: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportMessage: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionId: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionName: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStarted: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStopped: vi.fn((..._args: unknown[]) => Promise.resolve({})),
}));

vi.mock("@pragma-sh/sdk", () => ({
  hasPragmaEnvironment: () => true,
  reportAttention: (...args: unknown[]) => sdkMocks.reportAttention(...args),
  reportCleared: (...args: unknown[]) => sdkMocks.reportCleared(...args),
  reportMessage: (...args: unknown[]) => sdkMocks.reportMessage(...args),
  reportSessionId: (...args: unknown[]) => sdkMocks.reportSessionId(...args),
  reportSessionName: (...args: unknown[]) => sdkMocks.reportSessionName(...args),
  reportStarted: (...args: unknown[]) => sdkMocks.reportStarted(...args),
  reportStopped: (...args: unknown[]) => sdkMocks.reportStopped(...args),
}));

import PragmaOpencodeTuiPlugin from "./tui";

type Event = { type: string; data: Record<string, unknown> };
type Route = { type: "home" } | { type: "session"; sessionID: string };

/** A minimal TUI context: a routed session, a session tree, and a pushable event feed. */
function fakeContext(options: { route: Route; parents?: Record<string, string>; tabs?: string[] }) {
  let listener: ((event: { details: Event }) => void) | undefined;
  let route = options.route;
  const parents = options.parents ?? {};
  const root = (id: string): string => (parents[id] ? root(parents[id]) : id);
  const ctx = {
    options: { env: { PRAGMA_TAB_ID: "tab-1" } },
    data: {
      listen(handler: (event: { details: Event }) => void) {
        listener = handler;
        return () => (listener = undefined);
      },
      session: { root },
    },
    ui: {
      router: { current: () => route },
      tabs: {
        enabled: () => options.tabs !== undefined,
        list: () => (options.tabs ?? []).map((sessionID) => ({ sessionID })),
      },
    },
  };
  return {
    ctx: ctx as never,
    emit: (...events: Event[]) => {
      for (const event of events) listener?.({ details: event });
    },
    setRoute: (next: Route) => {
      route = next;
    },
  };
}

function attentionKinds(): unknown[] {
  return sdkMocks.reportAttention.mock.calls.map((call) => (call[0] as { kind: string }).kind);
}

/** A queued user prompt. Events run in order, so once its message is reported the ones before it are done. */
function prompt(sessionID: string, text: string): Event {
  return {
    type: "session.inbox.enqueued",
    data: { sessionID, inboxID: `msg_${text}`, item: { type: "user", payload: { text } } },
  };
}

function messageTexts(): unknown[] {
  return sdkMocks.reportMessage.mock.calls.map(
    (call) => (call[0] as { message: { text?: string } }).message.text,
  );
}

beforeEach(() => {
  for (const mock of Object.values(sdkMocks)) mock.mockClear();
});

describe("PragmaOpencodeTuiPlugin", () => {
  it("is a v2 TUI plugin definition sharing the server entry's id", () => {
    expect(PragmaOpencodeTuiPlugin.id).toBe("pragma.opencode");
  });

  it("reports a subagent's permission and the parent's completion", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "session", sessionID: "ses_root" } });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit(
      { type: "session.execution.started", data: { sessionID: "ses_root" } },
      { type: "session.created", data: { sessionID: "ses_child", parentID: "ses_root" } },
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_child", action: "bash", resources: ["rm -rf dist"] },
      },
      {
        type: "permission.replied",
        data: { sessionID: "ses_child", requestID: "per_1", reply: "once" },
      },
      { type: "session.execution.succeeded", data: { sessionID: "ses_child" } },
      { type: "session.execution.succeeded", data: { sessionID: "ses_root" } },
    );
    await vi.waitFor(() => expect(sdkMocks.reportStopped).toHaveBeenCalledTimes(1));

    expect(attentionKinds()).toEqual(["command"]);
    expect(sdkMocks.reportAttention.mock.calls[0]?.[0]).toMatchObject({ command: "rm -rf dist" });
    expect(sdkMocks.reportStarted).toHaveBeenCalled();
    await (cleanup as () => Promise<void>)();
  });

  it("reports a queued user message as the prompt", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "session", sessionID: "ses_root" } });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_root",
        inboxID: "msg_1",
        item: { type: "user", payload: { text: "fix the bug" } },
      },
    });
    await vi.waitFor(() =>
      expect(sdkMocks.reportMessage.mock.calls.at(-1)?.[0]).toMatchObject({
        message: { role: "user", text: "fix the bug" },
      }),
    );
    expect(sdkMocks.reportStarted).toHaveBeenCalled();
    expect(sdkMocks.reportSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ses_root" }),
    );
    await (cleanup as () => Promise<void>)();
  });

  it("ignores sessions another TUI on the same service is showing", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "session", sessionID: "ses_mine" } });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit(
      { type: "session.execution.started", data: { sessionID: "ses_other" } },
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_other", action: "bash", resources: ["ls"] },
      },
    );
    await (cleanup as () => Promise<void>)();

    expect(sdkMocks.reportStarted).not.toHaveBeenCalled();
    expect(sdkMocks.reportAttention).not.toHaveBeenCalled();
  });

  it("keeps reporting an open session tab after the route moves away", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "home" }, tabs: ["ses_tab"] });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit({ type: "session.execution.started", data: { sessionID: "ses_tab" } });
    await vi.waitFor(() => expect(sdkMocks.reportStarted).toHaveBeenCalledTimes(1));
    await (cleanup as () => Promise<void>)();
  });

  it("keeps one session's completion from reporting another running tab as finished", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "home" }, tabs: ["ses_a", "ses_b"] });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit(
      { type: "session.execution.started", data: { sessionID: "ses_a" } },
      { type: "session.execution.started", data: { sessionID: "ses_b" } },
      { type: "session.execution.succeeded", data: { sessionID: "ses_a" } },
      prompt("ses_b", "after"),
    );
    await vi.waitFor(() => expect(messageTexts()).toContain("after"));
    expect(sdkMocks.reportStopped).not.toHaveBeenCalled();

    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_b" } });
    await vi.waitFor(() => expect(sdkMocks.reportStopped).toHaveBeenCalledTimes(1));
    await (cleanup as () => Promise<void>)();
  });

  it("keeps another tab's pending prompt when a different session errors", async () => {
    const { ctx, emit } = fakeContext({ route: { type: "home" }, tabs: ["ses_a", "ses_b"] });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit(
      { type: "session.execution.started", data: { sessionID: "ses_b" } },
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_a", action: "bash", resources: ["rm -rf dist"] },
      },
      { type: "session.execution.failed", data: { sessionID: "ses_b", error: {} } },
      { type: "session.execution.started", data: { sessionID: "ses_b" } },
      prompt("ses_b", "after"),
    );
    await vi.waitFor(() => expect(messageTexts()).toContain("after"));

    // ses_a's approval is still pending, so ses_b's turns must not re-report the tab.
    expect(attentionKinds()).toEqual(["command"]);
    expect(sdkMocks.reportStarted).toHaveBeenCalledTimes(1);
    await (cleanup as () => Promise<void>)();
    expect(sdkMocks.reportStopped).not.toHaveBeenCalled();
  });

  it("stops reporting a session once this TUI no longer shows it", async () => {
    const { ctx, emit, setRoute } = fakeContext({ route: { type: "session", sessionID: "ses_a" } });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    emit({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    await vi.waitFor(() => expect(sdkMocks.reportStarted).toHaveBeenCalledTimes(1));

    // The session is closed here while it keeps running, as when it is resumed in another TUI.
    setRoute({ type: "home" });
    sdkMocks.reportCleared.mockClear();
    emit({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_a", action: "bash", resources: ["ls"] },
    });
    await vi.waitFor(() => expect(sdkMocks.reportCleared).toHaveBeenCalled());
    await (cleanup as () => Promise<void>)();

    expect(attentionKinds()).toEqual([]);
  });

  it("clears the indicator when the TUI exits", async () => {
    const { ctx } = fakeContext({ route: { type: "home" } });
    const cleanup = await PragmaOpencodeTuiPlugin.setup(ctx);
    sdkMocks.reportCleared.mockClear();
    await (cleanup as () => Promise<void>)();
    expect(sdkMocks.reportCleared).toHaveBeenCalled();
  });
});
