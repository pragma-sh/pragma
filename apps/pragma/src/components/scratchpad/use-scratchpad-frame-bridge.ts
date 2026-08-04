import { useEffect, useRef, type RefObject } from "react";

import type { Tab } from "@pragma/constants";
import type { ScratchpadAgentProgress } from "@pragma/scratchpad";

import { scratchpadTheme } from "@/lib/scratchpad-theme";
import { scratchpadPromptAgent } from "@/lib/tauri";
import { THEME_CHANGED_EVENT } from "@/lib/theme";
import { isNumber, isOneOf, isString, matchesShape } from "@/lib/type-guards";
import { useAgentStatusSnapshot, type AgentStatusEntry } from "@/state/agent-status-store";
import { useWorkspace } from "@/state/workspace-context";

/** Bounds applied to a frame-reported height before it becomes the iframe's size. */
const MIN_FRAME_HEIGHT = 64;
const MAX_FRAME_HEIGHT = 4096;

/** A request posted by the sandboxed preview frame to its host. */
interface FrameRequest {
  channel: "pragma-scratchpad";
  token: string;
  type: "request";
  id: string;
  method:
    | "promptAgent"
    | "requestAgentAttachment"
    | "subscribeAgentProgress"
    | "unsubscribeAgentProgress";
  text?: string;
  tabIds?: string[];
}

export interface ScratchpadFrameBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Per-frame secret; every message in either direction must carry it. */
  token: string;
  worktreeId: string;
  /** Changing document identity, used to drop subscriptions belonging to the old frame. */
  srcDoc: string | null;
  getAttachedAgentTabId: () => string | null;
  onRequestAgentAttachment: () => Promise<boolean>;
  onRenderError: (message: string) => void;
  onResize: (height: number) => void;
}

/**
 * Wires the host side of the sandboxed preview frame: routes the frame's `postMessage`
 * requests, keeps its agent-progress subscriptions fed, and restyles it on theme changes.
 */
export function useScratchpadFrameBridge({
  iframeRef,
  token,
  worktreeId,
  srcDoc,
  getAttachedAgentTabId,
  onRequestAgentAttachment,
  onRenderError,
  onResize,
}: ScratchpadFrameBridgeOptions): void {
  const subscriptionsRef = useRef(new Map<string, string[]>());
  const workspace = useWorkspace();
  const statuses = useAgentStatusSnapshot();
  const getAttachedRef = useRef(getAttachedAgentTabId);
  getAttachedRef.current = getAttachedAgentTabId;

  const post = (message: object): void => {
    iframeRef.current?.contentWindow?.postMessage(
      { channel: "pragma-scratchpad", token, ...message },
      "*",
    );
  };

  const postProgress = (id: string, tabIds: readonly string[]): void => {
    post({
      type: "progress",
      id,
      entries: frameProgress(workspace.tabs, statuses, worktreeId, tabIds),
    });
  };

  /** Handles the frame's out-of-band notices. Returns true when the message was one. */
  const applyNotice = (data: unknown): boolean => {
    if (isFrameRenderError(data, token)) {
      onRenderError(data.message);
      return true;
    }
    if (isFrameResize(data, token)) {
      onResize(Math.max(MIN_FRAME_HEIGHT, Math.min(data.height, MAX_FRAME_HEIGHT)));
      return true;
    }
    return false;
  };

  /** Handles subscribe/unsubscribe requests. Returns true when the request was one. */
  const applySubscription = (request: FrameRequest): boolean => {
    if (request.method === "unsubscribeAgentProgress") {
      subscriptionsRef.current.delete(request.id);
      return true;
    }
    if (request.method === "subscribeAgentProgress") {
      const tabIds = request.tabIds ?? [];
      subscriptionsRef.current.set(request.id, tabIds);
      postProgress(request.id, tabIds);
      return true;
    }
    return false;
  };

  const handleRequest = async (request: FrameRequest): Promise<void> => {
    try {
      if (request.method === "requestAgentAttachment") {
        post({ type: "response", id: request.id, value: await onRequestAgentAttachment() });
        return;
      }
      const tabId = getAttachedRef.current();
      const attachedExists = workspace.tabs.some(
        (tab) => tab.id === tabId && tab.worktreeId === worktreeId && tab.agentId,
      );
      if (!tabId || !attachedExists) {
        post({ type: "response", id: request.id, value: "missing-agent" });
        return;
      }
      await scratchpadPromptAgent(worktreeId, tabId, request.text ?? "");
      post({ type: "response", id: request.id, value: "sent" });
    } catch (cause) {
      post({
        type: "response",
        id: request.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (applyNotice(event.data)) return;
      if (!isFrameRequest(event.data, token)) return;
      if (applySubscription(event.data)) return;
      void handleRequest(event.data);
    };
    globalThis.addEventListener("message", receive);
    return () => globalThis.removeEventListener("message", receive);
  });

  useEffect(() => {
    for (const [id, tabIds] of subscriptionsRef.current) postProgress(id, tabIds);
    // Current render owns latest status/tab snapshot; callback identity is intentionally excluded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, workspace.tabs]);

  useEffect(() => {
    subscriptionsRef.current.clear();
  }, [srcDoc]);

  // Theme edits and color-scheme switches restyle a live frame in place; a
  // rebuild would discard the component state the scratchpad is holding.
  useEffect(() => {
    const publish = (): void => {
      const theme = scratchpadTheme();
      post({ type: "theme", mode: theme.mode, css: theme.css });
    };
    globalThis.addEventListener(THEME_CHANGED_EVENT, publish);
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
    return () => {
      globalThis.removeEventListener(THEME_CHANGED_EVENT, publish);
      observer.disconnect();
    };
    // `post` closes over a ref, so it is stable across renders by construction.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Progress entries for the requested tabs, preferring live status over the tab's own record. */
function frameProgress(
  tabs: readonly Tab[],
  statuses: readonly AgentStatusEntry[],
  worktreeId: string,
  tabIds: readonly string[],
): ScratchpadAgentProgress[] {
  const requested = new Set(tabIds);
  return tabs
    .filter((tab) => requested.has(tab.id) && tab.worktreeId === worktreeId && tab.agentId)
    .map((tab) => {
      const live = statuses.find(
        (status) => status.worktreeId === worktreeId && status.tabId === tab.id,
      );
      return {
        tabId: tab.id,
        title: tab.title ?? undefined,
        agent: live?.agent ?? tab.agentId ?? undefined,
        status: live?.status ?? "cleared",
      };
    });
}

function isFrameRequest(value: unknown, token: string): value is FrameRequest {
  return matchesShape(value, {
    channel: isOneOf("pragma-scratchpad"),
    token: isOneOf(token),
    type: isOneOf("request"),
    id: isString,
    method: isOneOf(
      "promptAgent",
      "requestAgentAttachment",
      "subscribeAgentProgress",
      "unsubscribeAgentProgress",
    ),
  });
}

function isFrameRenderError(
  value: unknown,
  token: string,
): value is { token: string; type: "render-error"; message: string } {
  return matchesShape(value, {
    token: isOneOf(token),
    type: isOneOf("render-error"),
    message: isString,
  });
}

function isFrameResize(
  value: unknown,
  token: string,
): value is { token: string; type: "resize"; height: number } {
  return matchesShape(value, {
    token: isOneOf(token),
    type: isOneOf("resize"),
    height: isNumber,
  });
}
