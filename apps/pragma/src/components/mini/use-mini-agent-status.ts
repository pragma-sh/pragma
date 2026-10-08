import { useEffect, useRef } from "react";

import type { AgentReportPayload } from "@pragma-sh/constants";

import { type MiniTab } from "@/components/mini/mini-tabs";
import { tabTitle } from "@/components/tabs/tab-label";
import {
  alertAgent,
  dismissAlertToastsForTab,
  latchAlertedStatus,
  releaseAlertLatch,
  releaseAlertLatchForTab,
  shouldAlertForStatus,
} from "@/lib/agent-alert";
import {
  markAgentsSeen,
  onAgentMessage,
  onAgentNotificationClick,
  onAgentReport,
  onAgentStatusReset,
} from "@/lib/tauri";
import {
  applyAgentMessage,
  applyAgentReport,
  clearAllAgentStatuses,
  clearDoneStatusForTab,
  removeAgentStatusForTab,
} from "@/state/agent-status-store";

/**
 * Agent status for one mini window's tabs. Every window receives every report;
 * this one keeps only its own tabs' (the main window ignores mini sessions, see
 * `isMiniSessionId`), alerts for a tab that is not on screen, and treats the
 * active tab as seen — the same latch rules as the workspace.
 */
export function useMiniAgentStatus(
  tabs: MiniTab[],
  activeTabId: string | null,
  onActivateTab: (tabId: string) => void,
): void {
  const tabsRef = useRef(new Map<string, MiniTab>());
  const activeRef = useRef(activeTabId);
  tabsRef.current = new Map(tabs.map((tab) => [tab.id, tab]));
  activeRef.current = activeTabId;
  const activateRef = useRef(onActivateTab);
  activateRef.current = onActivateTab;

  useEffect(() => {
    const activate = (tabId: string) => {
      if (tabsRef.current.has(tabId)) activateRef.current(tabId);
    };
    const unlisteners = [
      onAgentNotificationClick((payload) => activate(payload.tabId)),
      onAgentStatusReset(clearAllAgentStatuses),
      onAgentReport((payload) => {
        const tab = tabsRef.current.get(payload.tabId);
        if (tab && payload.status)
          handleReport(payload, tab, activeRef.current === tab.id, () => activate(tab.id));
      }),
      onAgentMessage((message) => {
        if (tabsRef.current.has(message.tabId)) applyAgentMessage(message);
      }),
    ];
    return () => {
      for (const unlisten of unlisteners) void unlisten.then((stop) => stop());
    };
  }, []);

  // Viewing a tab acknowledges its finished agents, here and on the server.
  useEffect(() => {
    if (!activeTabId) return;
    clearDoneStatusForTab(activeTabId);
    dismissAlertToastsForTab(activeTabId);
    void markAgentsSeen(activeTabId).catch(() => undefined);
  }, [activeTabId]);

  // A closed (or re-homed) tab drops its dots and alert latches.
  const knownIds = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(tabs.map((tab) => tab.id));
    for (const id of knownIds.current) {
      if (!current.has(id)) {
        removeAgentStatusForTab(id);
        releaseAlertLatchForTab(id);
      }
    }
    knownIds.current = current;
  }, [tabs]);
}

function handleReport(
  payload: AgentReportPayload,
  tab: MiniTab,
  viewed: boolean,
  onGoTo: () => void,
): void {
  applyAgentReport(payload);
  if (payload.status === "running" || payload.status === "cleared") {
    releaseAlertLatch(payload);
    return;
  }
  if (payload.status !== "done" && payload.status !== "attention") return;
  if (viewed) {
    if (payload.status === "done") {
      clearDoneStatusForTab(tab.id);
      void markAgentsSeen(tab.id).catch(() => undefined);
    }
    latchAlertedStatus(payload);
    return;
  }
  if (!shouldAlertForStatus(payload)) return;
  latchAlertedStatus(payload);
  void alertAgent(payload, {
    onGoTo,
    goToLabel: "Go to tab",
    ...describeMiniAgentLocation(tab),
  });
}

/** Resolves notification context without mixing location rules into status transitions. */
function describeMiniAgentLocation(tab: MiniTab) {
  const location = tab.location;
  if (location.kind === "home") {
    return {
      location: { projectName: null, worktreeName: null, tabName: tabTitle(tab) },
    };
  }
  return {
    projectId: tab.projectId,
    location: {
      projectName: location.projectName,
      worktreeName: location.worktreeName,
      tabName: tabTitle(tab),
    },
  };
}
