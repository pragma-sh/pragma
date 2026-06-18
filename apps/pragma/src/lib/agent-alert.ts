import type { AgentReportPayload } from "@pragma/constants";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createElement } from "react";
import { toast } from "sonner";

let lastChime = 0;
const CHIME_DEBOUNCE_MS = 750;
const RECENT_ALERT_DEDUPE_MS = 2_000;
const activeToastByKey = new Map<string, string | number>();
const recentAlertAtByKey = new Map<string, number>();
let permissionPromise: Promise<boolean> | null = null;

export interface AgentAlertOptions {
  onGoTo?: () => void;
}

/** Plays a short alert and surfaces a focused/unfocused notification. */
export async function alertAgent(payload: AgentReportPayload, options: AgentAlertOptions = {}) {
  const key = alertKey(payload);
  const recent = recentAlertAtByKey.get(key) ?? 0;
  const now = Date.now();
  if (activeToastByKey.has(key) || now - recent < RECENT_ALERT_DEDUPE_MS) {
    return;
  }
  recentAlertAtByKey.set(key, now);
  playChime();
  const title = titleFor(payload);
  const description = descriptionFor(payload);
  if (await isAppFocused()) {
    const id = toast.custom((toastId) => agentToast(toastId, title, description, options, key), {
      duration: Infinity,
      onDismiss: () => activeToastByKey.delete(key),
    });
    activeToastByKey.set(key, id);
    return;
  }
  try {
    if (await ensureNotificationPermission()) {
      sendNotification({ title, body: description });
    }
  } catch {
    // System notification support is best-effort; the chime has already played.
  }
}

/**
 * Requests OS notification permission up front (call once at startup, while the
 * app is still frontmost). Doing it lazily from the first alert is unreliable:
 * if that alert fires while the app is unfocused, the macOS auth prompt opens
 * behind other windows where the user never sees it and the notification is lost.
 */
export function primeNotificationPermission(): void {
  void ensureNotificationPermission();
}

async function isAppFocused(): Promise<boolean> {
  const documentVisible = document.visibilityState === "visible";
  try {
    // An occluded/minimized window can still report OS focus, so also require the
    // document to be visible — otherwise we'd skip the notification the user needs.
    return (await getCurrentWindow().isFocused()) && documentVisible;
  } catch {
    return document.hasFocus() && documentVisible;
  }
}

function ensureNotificationPermission(): Promise<boolean> {
  permissionPromise ??= requestNotificationPermission();
  return permissionPromise;
}

async function requestNotificationPermission(): Promise<boolean> {
  try {
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (!granted) {
      // Don't cache a denial/error forever — let a later alert retry so a
      // permission granted afterwards in System Settings is picked up.
      permissionPromise = null;
    }
    return granted;
  } catch {
    permissionPromise = null;
    return false;
  }
}

function agentToast(
  toastId: string | number,
  title: string,
  description: string,
  options: AgentAlertOptions,
  key: string,
) {
  const dismiss = () => {
    activeToastByKey.delete(key);
    toast.dismiss(toastId);
  };
  return createElement(
    "button",
    {
      type: "button",
      className:
        "flex w-full max-w-sm flex-col gap-2 rounded-md border border-border bg-popover px-4 py-3 text-left text-popover-foreground shadow-lg",
      onClick: dismiss,
    },
    createElement("span", { className: "text-sm font-medium" }, title),
    createElement("span", { className: "text-xs text-muted-foreground" }, description),
    createElement(
      "span",
      { className: "flex items-center gap-2 pt-1" },
      options.onGoTo
        ? createElement(
            "span",
            {
              className: "rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground",
              onClick: (event: MouseEvent) => {
                event.stopPropagation();
                dismiss();
                options.onGoTo?.();
              },
            },
            "Go to worktree",
          )
        : null,
      createElement(
        "span",
        { className: "rounded border border-border px-2 py-1 text-xs text-muted-foreground" },
        "Dismiss",
      ),
    ),
  );
}

function alertKey(payload: AgentReportPayload): string {
  return [
    payload.worktreeId,
    payload.tabId,
    payload.agent,
    payload.status,
    payload.attentionKind ?? "",
  ].join("\u0000");
}

function playChime(): void {
  const now = Date.now();
  if (now - lastChime < CHIME_DEBOUNCE_MS) {
    return;
  }
  lastChime = now;
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }
  const context = new AudioContextCtor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 880;
  gain.gain.value = 0.03;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.12);
}

function titleFor(payload: AgentReportPayload): string {
  if (payload.status === "done") {
    return `${payload.agent} finished`;
  }
  if (payload.attentionKind === "command") {
    return `${payload.agent} wants to run a command`;
  }
  return `${payload.agent} needs attention`;
}

function descriptionFor(payload: AgentReportPayload): string {
  if (payload.status === "done") {
    return "The agent has stopped in this worktree.";
  }
  if (payload.attentionKind === "question") {
    return "The agent is waiting for an answer.";
  }
  if (payload.attentionKind === "command") {
    return "Review the requested command in its terminal.";
  }
  return "Open the agent terminal to continue.";
}
