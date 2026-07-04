import type { AgentReportPayload } from "@pragma/constants";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isFocusedMock = vi.fn();
const isPermissionGrantedMock = vi.fn();
const listPluginAgentsMock = vi.fn();
const requestPermissionMock = vi.fn();
const sendNotificationMock = vi.fn();
const showAgentNotificationMock = vi.fn();
const audioWindow = window as unknown as {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};
const originalAudioContext = audioWindow.AudioContext;
const originalWebkitAudioContext = audioWindow.webkitAudioContext;

vi.mock("@/lib/tauri", () => ({
  showAgentNotification: (...args: unknown[]) => showAgentNotificationMock(...args),
}));

vi.mock("@/plugins/agents", () => ({
  listPluginAgents: () => listPluginAgentsMock(),
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

    isFocusedMock.mockResolvedValue(false);
    isPermissionGrantedMock.mockResolvedValue(true);
    listPluginAgentsMock.mockReturnValue([
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    showAgentNotificationMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    AudioContextMock.instances = [];
    restoreAudioContexts();
  });

  it("uses the configured agent name in notification titles", async () => {
    await alertAgent(report());

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "OpenCode needs attention",
      body: "The agent is waiting for an answer.",
    });
  });

  it("uses native clickable notifications when a project destination is known", async () => {
    showAgentNotificationMock.mockResolvedValue(true);

    await alertAgent(report({ tabId: "tab-1" }), { projectId: "project-1" });

    expect(showAgentNotificationMock).toHaveBeenCalledWith(
      "OpenCode needs attention",
      "The agent is waiting for an answer.",
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
      title: "OpenCode needs attention",
      body: "The agent is waiting for an answer.",
    });
  });
});

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

  it("drops latches for a closed tab", () => {
    const done = report({ status: "done", attentionKind: undefined });
    latchAlertedStatus(done);

    releaseAlertLatchForTab(done.tabId);
    expect(shouldAlertForStatus(done)).toBe(true);
  });
});
