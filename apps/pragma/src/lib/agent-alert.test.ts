import type { AgentReportPayload } from "@pragma/constants";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isFocusedMock = vi.fn();
const isPermissionGrantedMock = vi.fn();
const listPluginAgentsMock = vi.fn();
const requestPermissionMock = vi.fn();
const sendNotificationMock = vi.fn();
const showAgentNotificationMock = vi.fn();
const resolveAgentApprovalMock = vi.fn();
const startWatcherForAgentSessionMock = vi.fn();
const audioWindow = window as unknown as {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};
const originalAudioContext = audioWindow.AudioContext;
const originalWebkitAudioContext = audioWindow.webkitAudioContext;

vi.mock("@/lib/tauri", () => ({
  showAgentNotification: (...args: unknown[]) => showAgentNotificationMock(...args),
  resolveAgentApproval: (...args: unknown[]) => resolveAgentApprovalMock(...args),
}));

vi.mock("@/plugins/agents", () => ({
  listPluginAgents: () => listPluginAgentsMock(),
}));

vi.mock("@/plugins/watchers", () => ({
  startWatcherForAgentSession: (...args: unknown[]) => startWatcherForAgentSessionMock(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: () => isFocusedMock() }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGrantedMock(),
  requestPermission: () => requestPermissionMock(),
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
}));

import {
  alertAgent,
  latchAlertedStatus,
  releaseAlertLatch,
  releaseAlertLatchForTab,
  shouldAlertForStatus,
} from "./agent-alert";

function report(overrides: Partial<AgentReportPayload> = {}): AgentReportPayload {
  return {
    agent: "opencode",
    status: "attention",
    attentionKind: "question",
    tabId: `tab-${crypto.randomUUID()}`,
    worktreeId: "worktree-1",
    ...overrides,
  };
}

function setAudioContext(value: unknown): void {
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreAudioContexts(): void {
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value: originalAudioContext,
  });
  Object.defineProperty(window, "webkitAudioContext", {
    configurable: true,
    writable: true,
    value: originalWebkitAudioContext,
  });
}

function fakeFutureTime(offsetMs: number): void {
  const future = Date.now() + offsetMs;
  vi.useFakeTimers();
  vi.setSystemTime(future);
}

class AudioContextMock {
  static instances: AudioContextMock[] = [];

  currentTime = 0;
  destination = {};
  closed = false;
  oscillator = {
    addEventListener: vi.fn(),
    connect: vi.fn(),
    frequency: { value: 0 },
    start: vi.fn(),
    stop: vi.fn(),
  };
  gain = {
    connect: vi.fn(),
    gain: { value: 0 },
  };
  close = vi.fn(() => {
    this.closed = true;
    return Promise.resolve();
  });

  constructor() {
    AudioContextMock.instances.push(this);
  }

  createOscillator = vi.fn(() => this.oscillator);
  createGain = vi.fn(() => this.gain);
}

function BlockedAudioContext() {
  throw new Error("blocked");
}

describe("alertAgent", () => {
  beforeEach(() => {
    isFocusedMock.mockReset();
    isPermissionGrantedMock.mockReset();
    listPluginAgentsMock.mockReset();
    requestPermissionMock.mockReset();
    sendNotificationMock.mockReset();
    showAgentNotificationMock.mockReset();
    resolveAgentApprovalMock.mockReset();
    startWatcherForAgentSessionMock.mockReset();

    isFocusedMock.mockResolvedValue(false);
    isPermissionGrantedMock.mockResolvedValue(true);
    listPluginAgentsMock.mockReturnValue([
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    showAgentNotificationMock.mockResolvedValue(false);
    startWatcherForAgentSessionMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    AudioContextMock.instances = [];
    restoreAudioContexts();
  });

  it("uses the configured agent name in notification titles", async () => {
    await alertAgent(report());

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "OpenCode is waiting for an answer",
      body: "Open Pragma to continue.",
    });
  });

  it("names the project, worktree, and tab the report came from", async () => {
    await alertAgent(report(), {
      location: { projectName: "pragma", worktreeName: "bugfix-auth", tabName: "dev" },
    });

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "OpenCode is waiting for an answer",
      body: 'pragma / bugfix-auth \u00b7 tab "dev"',
    });
  });

  it("uses native clickable notifications when a project destination is known", async () => {
    showAgentNotificationMock.mockResolvedValue(true);

    await alertAgent(report({ tabId: "tab-1" }), { projectId: "project-1" });

    expect(showAgentNotificationMock).toHaveBeenCalledWith(
      "OpenCode is waiting for an answer",
      "Open Pragma to continue.",
      "project-1",
      "worktree-1",
      "tab-1",
    );
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("closes the chime audio context after playback", async () => {
    fakeFutureTime(1_000);
    setAudioContext(AudioContextMock);

    await alertAgent(report({ tabId: "tab-audio-close" }));

    const context = AudioContextMock.instances[0];
    expect(context).toBeDefined();
    if (!context) {
      return;
    }
    expect(context.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await Promise.resolve();

    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("continues alerting when AudioContext construction is blocked", async () => {
    fakeFutureTime(2_000);
    setAudioContext(BlockedAudioContext);

    await expect(alertAgent(report({ tabId: "tab-audio-blocked" }))).resolves.toBeUndefined();

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "OpenCode is waiting for an answer",
      body: "Open Pragma to continue.",
    });
  });

  it("shows the command and auto-approves it from the toast", async () => {
    isFocusedMock.mockResolvedValue(true); // focused -> the in-app toast path
    const { toast } = await import("sonner");
    const customMock = toast.custom as unknown as ReturnType<typeof vi.fn>;
    customMock.mockClear();

    await alertAgent(
      report({
        tabId: "tab-cmd",
        status: "attention",
        attentionKind: "command",
        command: "rm -rf ./dist",
        requestId: "req-1",
      }),
    );

    expect(customMock).toHaveBeenCalledTimes(1);
    expect(startWatcherForAgentSessionMock).toHaveBeenCalledWith({
      agentId: "opencode",
      sessionId: "tab-cmd",
      tabId: "tab-cmd",
      worktreeId: "worktree-1",
    });
    const render = customMock.mock.calls[0]?.[0] as (id: string) => unknown;
    const element = render("toast-1");

    expect(
      findNode(element, (node) => node.type === "code" && node.props?.children === "rm -rf ./dist"),
    ).toBeDefined();
    const approve = findNode(
      element,
      (node) => node.type === "button" && node.props?.children === "Approve",
    );
    expect(approve).toBeDefined();

    approve?.props?.onClick?.();
    expect(resolveAgentApprovalMock).toHaveBeenCalledWith({
      agent: "opencode",
      worktreeId: "worktree-1",
      tabId: "tab-cmd",
      requestId: "req-1",
      approved: true,
    });
  });

  it("still renders the approval toast when the app is unfocused", async () => {
    isFocusedMock.mockResolvedValue(false); // unfocused -> would normally be OS-notification only
    isPermissionGrantedMock.mockResolvedValue(true);
    const { toast } = await import("sonner");
    const customMock = toast.custom as unknown as ReturnType<typeof vi.fn>;
    customMock.mockClear();

    await alertAgent(
      report({
        tabId: "tab-cmd-unfocused",
        status: "attention",
        attentionKind: "command",
        command: "rm -rf ./dist",
        requestId: "req-2",
      }),
    );

    // The interactive Approve toast is rendered even unfocused...
    expect(customMock).toHaveBeenCalledTimes(1);
    const render = customMock.mock.calls[0]?.[0] as (id: string) => unknown;
    const approve = findNode(
      render("toast-2"),
      (node) => node.type === "button" && node.props?.children === "Approve",
    );
    expect(approve).toBeDefined();
    // ...and the native banner still fires to draw the user back to the window.
    expect(sendNotificationMock).toHaveBeenCalled();
  });

  it("keeps approval available when command text is missing", async () => {
    isFocusedMock.mockResolvedValue(true);
    const { toast } = await import("sonner");
    const customMock = toast.custom as unknown as ReturnType<typeof vi.fn>;
    customMock.mockClear();

    await alertAgent(
      report({
        tabId: "tab-cmd-missing",
        status: "attention",
        attentionKind: "command",
        requestId: "req-missing",
      }),
    );

    const render = customMock.mock.calls[0]?.[0] as (id: string) => unknown;
    const element = render("toast-missing");

    expect(
      findNode(
        element,
        (node) =>
          node.type === "code" &&
          node.props?.children ===
            "Command details unavailable. Review terminal prompt before approving.",
      ),
    ).toBeDefined();
    const approve = findNode(
      element,
      (node) => node.type === "button" && node.props?.children === "Approve",
    );

    approve?.props?.onClick?.();
    expect(resolveAgentApprovalMock).toHaveBeenCalledWith({
      agent: "opencode",
      worktreeId: "worktree-1",
      tabId: "tab-cmd-missing",
      requestId: "req-missing",
      approved: true,
    });
  });
});

interface ElementNode {
  type?: unknown;
  props?: { children?: unknown; onClick?: () => void };
}

/** Depth-first walk of a createElement tree returning the first matching node. */
function findNode(
  node: unknown,
  predicate: (node: ElementNode) => boolean,
): ElementNode | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const element = node as ElementNode;
  if (predicate(element)) {
    return element;
  }
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    const found = findNode(child, predicate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe("alert latch", () => {
  it("alerts once for a status, then suppresses identical re-deliveries", () => {
    const done = report({ status: "done", attentionKind: undefined });

    expect(shouldAlertForStatus(done)).toBe(true);
    latchAlertedStatus(done);
    // A daemon snapshot replay on reconnect delivers the same `done` again.
    expect(shouldAlertForStatus(done)).toBe(false);
  });

  it("suppresses re-delivery even after the tab was viewed (dot cleared)", () => {
    const done = report({ status: "done", attentionKind: undefined });
    latchAlertedStatus(done);
    // Viewing clears the dot store but must not release the alert latch.
    expect(shouldAlertForStatus(done)).toBe(false);
  });

  it("notifies again once the agent moves on and finishes a new turn", () => {
    const done = report({ status: "done", attentionKind: undefined });
    latchAlertedStatus(done);

    releaseAlertLatch({ ...done, status: "running" });
    expect(shouldAlertForStatus(done)).toBe(true);
  });

  it("treats attention and done as distinct latched statuses", () => {
    const tabId = `tab-${crypto.randomUUID()}`;
    const attention = report({ tabId, status: "attention", attentionKind: "question" });
    const done = report({ tabId, status: "done", attentionKind: undefined });

    latchAlertedStatus(attention);
    expect(shouldAlertForStatus(attention)).toBe(false);
    // A subsequent completion is still a new event.
    expect(shouldAlertForStatus(done)).toBe(true);
  });

  it("notifies for each command approval request", () => {
    const tabId = `tab-${crypto.randomUUID()}`;
    const first = report({
      tabId,
      status: "attention",
      attentionKind: "command",
      requestId: "req-1",
    });
    const second = report({
      tabId,
      status: "attention",
      attentionKind: "command",
      requestId: "req-2",
    });

    latchAlertedStatus(first);

    expect(shouldAlertForStatus(first)).toBe(false);
    expect(shouldAlertForStatus(second)).toBe(true);
  });

  it("drops latches for a closed tab", () => {
    const done = report({ status: "done", attentionKind: undefined });
    latchAlertedStatus(done);

    releaseAlertLatchForTab(done.tabId);
    expect(shouldAlertForStatus(done)).toBe(true);
  });
});
