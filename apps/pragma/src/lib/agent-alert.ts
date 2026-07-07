import type { AgentReportPayload, AgentStatus } from "@pragma/constants";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createElement } from "react";
import { toast } from "sonner";

import { resolveAgentApproval, showAgentNotification } from "@/lib/tauri";
import { listPluginAgents } from "@/plugins/agents";
import { startWatcherForAgentSession } from "@/plugins/watchers";

let lastChime = 0;
const CHIME_DEBOUNCE_MS = 750;
const RECENT_ALERT_DEDUPE_MS = 2_000;
const activeToastByKey = new Map<string, string | number>();
const recentAlertAtByKey = new Map<string, number>();
let permissionPromise: Promise<boolean> | null = null;
let agentNameByIdPromise: Promise<Map<string, string>> | null = null;

// The status (`done`/`attention`) each agent has already been alerted for — or
// has already been seen on screen. Keyed by worktree+tab+agent. This is the
// alert "latch": it is intentionally separate from the dot store (which viewing
// a tab clears), so that re-deliveries of the *same* status never re-notify.
// The daemon replays its full status snapshot on every reconnect, and keeps a
// `done` until the agent moves on, so without this latch a reconnect would
// re-fire "finished" notifications the user already saw.
const alertedStatusByKey = new Map<string, AgentStatus>();

function statusLatchKey(payload: AgentReportPayload): string {
  return [
    payload.worktreeId,
    payload.tabId,
    payload.agent,
    payload.attentionKind === "command" ? (payload.requestId ?? "") : "",
  ].join("\u0000");
}

/**
 * Whether `payload.status` warrants a *new* alert — true only if the agent has
 * not already been alerted for (or shown) this exact status since it last moved
 * on. Use {@link latchAlertedStatus} to record an alert and
 * {@link releaseAlertLatch} when the agent starts running or is cleared.
 */
export function shouldAlertForStatus(payload: AgentReportPayload): boolean {
  return alertedStatusByKey.get(statusLatchKey(payload)) !== payload.status;
}

/** Records that `payload.status` has been surfaced (alerted or seen on screen). */
export function latchAlertedStatus(payload: AgentReportPayload): void {
  alertedStatusByKey.set(statusLatchKey(payload), payload.status);
}

/**
 * Releases the latch so the agent's next `done`/`attention` notifies again.
 * Call when an agent starts running or is cleared — i.e. it genuinely moved on,
 * so a subsequent completion is a new event rather than a replay.
 */
export function releaseAlertLatch(payload: AgentReportPayload): void {
  alertedStatusByKey.delete(statusLatchKey(payload));
}

/** Drops every latch for a tab once it is closed, so its session id can't leak. */
export function releaseAlertLatchForTab(tabId: string): void {
  for (const key of alertedStatusByKey.keys()) {
    if (key.split("\u0000")[1] === tabId) {
      alertedStatusByKey.delete(key);
    }
  }
}

export interface AgentAlertOptions {
  projectId?: string;
  onGoTo?: () => void;
}

/** Plays a short alert and surfaces a focused/unfocused notification. */
// fallow-ignore-next-line complexity -- multi-branch alert dispatch (toast/chime/notification) is inherently conditional; splitting would not reduce cyclomatic count meaningfully
export async function alertAgent(payload: AgentReportPayload, options: AgentAlertOptions = {}) {
  const key = alertKey(payload);
  const recent = recentAlertAtByKey.get(key) ?? 0;
  const now = Date.now();
  if (activeToastByKey.has(key) || now - recent < RECENT_ALERT_DEDUPE_MS) {
    return;
  }
  recentAlertAtByKey.set(key, now);
  playChime();
  const agentName = await displayNameForAgent(payload.agent);
  const title = titleFor(payload, agentName);
  const description = descriptionFor(payload);
  const focused = await isAppFocused();
  if (isApprovableCommand(payload)) {
    void startWatcherForAgentSession({
      agentId: payload.agent,
      sessionId: payload.tabId,
      tabId: payload.tabId,
      worktreeId: payload.worktreeId,
    }).catch((cause: unknown) => {
      console.warn(`failed to start watcher for ${payload.agent}`, cause);
    });
  }
  // A command approval must always surface its interactive Approve/Deny toast —
  // its whole point is answering without touching the terminal, and these reports
  // usually arrive while the window is unfocused. So render the toast even when
  // unfocused; the native banner below still fires to draw the user back.
  if (focused || isApprovableCommand(payload)) {
    const id = toast.custom(
      (toastId) => agentToast(toastId, payload, title, description, options, key),
      {
        duration: Infinity,
        onDismiss: () => activeToastByKey.delete(key),
      },
    );
    activeToastByKey.set(key, id);
    if (focused) {
      return;
    }
  }
  try {
    if (await ensureNotificationPermission()) {
      let nativeShown = false;
      if (options.projectId) {
        try {
          nativeShown = await showAgentNotification(
            title,
            description,
            options.projectId,
            payload.worktreeId,
            payload.tabId,
          );
        } catch {
          nativeShown = false;
        }
      }
      if (nativeShown) {
        return;
      }
      sendNotification({ title, body: description });
    }
  } catch {
    // System notification support is best-effort; the chime has already played.
  }
}

async function displayNameForAgent(agentId: string): Promise<string> {
  try {
    agentNameByIdPromise ??= Promise.resolve(
      new Map(listPluginAgents().map((agent) => [agent.id, agent.name])),
    );
    const names = await agentNameByIdPromise;
    return names.get(agentId) ?? agentId;
  } catch {
    agentNameByIdPromise = null;
    return agentId;
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

/**
 * A command-approval report carries the command text plus a `requestId` so the
 * toast can approve it. Non-command attention and `done` reports omit both.
 */
function isApprovableCommand(
  payload: AgentReportPayload,
): payload is AgentReportPayload & { requestId: string } {
  return (
    payload.status === "attention" &&
    payload.attentionKind === "command" &&
    Boolean(payload.requestId)
  );
}

function agentToast(
  toastId: string | number,
  payload: AgentReportPayload,
  title: string,
  description: string,
  options: AgentAlertOptions,
  key: string,
) {
  const dismiss = () => {
    activeToastByKey.delete(key);
    toast.dismiss(toastId);
  };
  if (isApprovableCommand(payload)) {
    return commandApprovalToast(payload, title, dismiss);
  }
  return createElement(
    "button",
    {
      type: "button",
      className:
        "flex w-[var(--width)] flex-col gap-2 rounded-md border border-border bg-popover px-4 py-3 text-left text-popover-foreground shadow-lg",
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

/**
 * Toast for a command-approval report: shows the command and an Approve button
 * that runs it in the harness (via {@link resolveAgentApproval}) without the user
 * touching the terminal. Deny rejects it; Dismiss leaves the harness to its own
 * prompt (the hook falls back on timeout; a watcher simply does not answer).
 */
function commandApprovalToast(
  payload: AgentReportPayload & { requestId: string },
  title: string,
  dismiss: () => void,
) {
  const command =
    payload.command?.trim() ||
    "Command details unavailable. Review terminal prompt before approving.";
  const resolve = (approved: boolean) => {
    dismiss();
    void resolveAgentApproval({
      agent: payload.agent,
      worktreeId: payload.worktreeId,
      tabId: payload.tabId,
      requestId: payload.requestId,
      approved,
    });
  };
  return createElement(
    "div",
    {
      className:
        "flex w-[var(--width)] flex-col gap-2 rounded-md border border-border bg-popover px-4 py-3 text-left text-popover-foreground shadow-lg",
    },
    createElement("span", { className: "text-sm font-medium" }, title),
    createElement(
      "code",
      {
        className:
          "block max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-xs",
      },
      command,
    ),
    createElement(
      "span",
      { className: "flex items-center gap-2 pt-1" },
      createElement(
        "button",
        {
          type: "button",
          className: "rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground",
          onClick: () => resolve(true),
          ref: nativeClickRef(() => resolve(true)),
        },
        "Approve",
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "rounded border border-border px-2 py-1 text-xs",
          onClick: () => resolve(false),
          ref: nativeClickRef(() => resolve(false)),
        },
        "Deny",
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "rounded border border-border px-2 py-1 text-xs text-muted-foreground",
          onClick: dismiss,
          ref: nativeClickRef(dismiss),
        },
        "Dismiss",
      ),
    ),
  );
}

function nativeClickRef(handler: () => void): (node: HTMLButtonElement | null) => void {
  return (node) => {
    if (!node) {
      return;
    }
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
    });
  };
}

function alertKey(payload: AgentReportPayload): string {
  return [
    payload.worktreeId,
    payload.tabId,
    payload.agent,
    payload.status,
    payload.attentionKind ?? "",
    // A new command is a distinct approval even when the tab/agent match a prior
    // one, so key on requestId too — otherwise a second command would dedupe.
    payload.requestId ?? "",
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
  let context: AudioContext | undefined;
  try {
    context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    let didClose = false;
    const close = () => {
      if (didClose || !context) {
        return;
      }
      didClose = true;
      closeAudioContext(context);
    };

    oscillator.frequency.value = 880;
    gain.gain.value = 0.03;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener("ended", close, { once: true });
    window.setTimeout(close, 500);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  } catch {
    if (context) {
      closeAudioContext(context);
    }
  }
}

function closeAudioContext(context: AudioContext): void {
  try {
    void context.close().catch(() => {});
  } catch {
    // Audio alerts are best-effort; cleanup failures should not break reporting.
  }
}

function titleFor(payload: AgentReportPayload, agentName: string): string {
  if (payload.status === "done") {
    return `${agentName} finished`;
  }
  if (payload.attentionKind === "command") {
    return `${agentName} wants to run a command`;
  }
  return `${agentName} needs attention`;
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
