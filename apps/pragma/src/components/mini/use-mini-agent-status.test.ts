import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReportPayload } from "@pragma-sh/constants";

import { createMiniTab } from "./mini-tabs";
import { useMiniAgentStatus } from "./use-mini-agent-status";
import type { AgentNotificationClick } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  clicked: (_payload: AgentNotificationClick) => {},
  report: (_payload: AgentReportPayload) => {},
}));

vi.mock("@/lib/tauri", () => ({
  markAgentsSeen: vi.fn().mockResolvedValue(undefined),
  onAgentNotificationClick: (handler: typeof mocks.clicked) => {
    mocks.clicked = handler;
    return Promise.resolve(vi.fn());
  },
  onAgentReport: (handler: typeof mocks.report) => {
    mocks.report = handler;
    return Promise.resolve(vi.fn());
  },
  onAgentMessage: () => Promise.resolve(vi.fn()),
  onAgentStatusReset: () => Promise.resolve(vi.fn()),
}));

vi.mock("@/lib/agent-alert", () => ({
  alertAgent: mocks.alert,
  dismissAlertToastsForTab: vi.fn(),
  latchAlertedStatus: vi.fn(),
  releaseAlertLatch: vi.fn(),
  releaseAlertLatchForTab: vi.fn(),
  shouldAlertForStatus: () => true,
}));

vi.mock("@/state/agent-status-store", () => ({
  applyAgentMessage: vi.fn(),
  applyAgentReport: vi.fn(),
  clearAllAgentStatuses: vi.fn(),
  clearDoneStatusForTab: vi.fn(),
  removeAgentStatusForTab: vi.fn(),
}));

describe("Mini notification navigation", () => {
  beforeEach(() => mocks.alert.mockClear());

  it("selects the exact home tab and ignores other windows and closed tabs", () => {
    const first = createMiniTab({ kind: "home" }, "/home");
    const second = createMiniTab({ kind: "home" }, "/home");
    const activate = vi.fn();
    const { rerender } = renderHook(({ tabs }) => useMiniAgentStatus(tabs, first.id, activate), {
      initialProps: { tabs: [first, second] },
    });
    const click = { projectId: null, worktreeId: second.worktreeId, tabId: second.id };

    act(() => mocks.clicked(click));
    expect(activate).toHaveBeenCalledExactlyOnceWith(second.id);
    activate.mockClear();
    act(() => mocks.clicked({ ...click, tabId: "other-window-tab" }));
    rerender({ tabs: [first] });
    act(() => mocks.clicked(click));
    expect(activate).not.toHaveBeenCalled();
  });

  it("routes a background done toast to its reporting tab", () => {
    const first = createMiniTab({ kind: "home" }, "/home");
    const second = createMiniTab({ kind: "home" }, "/home");
    const activate = vi.fn();
    renderHook(() => useMiniAgentStatus([first, second], first.id, activate));

    act(() =>
      mocks.report({
        agent: "opencode",
        status: "done",
        worktreeId: second.worktreeId,
        tabId: second.id,
      }),
    );
    const options = mocks.alert.mock.calls[0]?.[1];
    expect(options).toMatchObject({ goToLabel: "Go to tab" });
    act(() => options.onGoTo());
    expect(activate).toHaveBeenCalledExactlyOnceWith(second.id);
  });
});
