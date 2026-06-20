import type { AgentReportPayload } from "@pragma/constants";

import { beforeEach, describe, expect, it, vi } from "vitest";

const isFocusedMock = vi.fn();
const isPermissionGrantedMock = vi.fn();
const listAgentsMock = vi.fn();
const requestPermissionMock = vi.fn();
const sendNotificationMock = vi.fn();
const showAgentNotificationMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listAgents: () => listAgentsMock(),
  showAgentNotification: (...args: unknown[]) => showAgentNotificationMock(...args),
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

describe("alertAgent", () => {
  beforeEach(() => {
    isFocusedMock.mockReset();
    isPermissionGrantedMock.mockReset();
    listAgentsMock.mockReset();
    requestPermissionMock.mockReset();
    sendNotificationMock.mockReset();
    showAgentNotificationMock.mockReset();

    isFocusedMock.mockResolvedValue(false);
    isPermissionGrantedMock.mockResolvedValue(true);
    listAgentsMock.mockResolvedValue([
      { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
    ]);
    showAgentNotificationMock.mockResolvedValue(false);
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
