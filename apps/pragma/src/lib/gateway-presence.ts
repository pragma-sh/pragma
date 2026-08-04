import { constants } from "@pragma/constants";
import { PragmaClient } from "@pragma/sdk";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { gatewayConnectionInfo } from "@/lib/tauri";

/**
 * Tells the gateway whether this desktop window is focused, so an alert the
 * user is already looking at here does not also buzz their phone.
 *
 * The gateway expires a heartbeat after `gateway.push.presenceTtlMs`, so a
 * desktop that quits (or crashes) while focused stops suppressing on its own —
 * which is why a focused window keeps re-reporting rather than reporting once.
 */
const HEARTBEAT_MS = Math.max(5_000, Math.floor(constants.gateway.push.presenceTtlMs / 3));

let client: Promise<PragmaClient> | null = null;
let heartbeat: number | null = null;
let started = false;
/** Whether the OS says this window holds focus. */
let windowFocused = false;
/** Whether the webview is actually on screen (not minimised or occluded). */
let documentVisible = true;
/** The last value sent to the gateway, so an unchanged state is not re-sent. */
let reportedFocus: boolean | null = null;

function gatewayClient(): Promise<PragmaClient> {
  client ??= gatewayConnectionInfo()
    .then((info) => new PragmaClient({ baseUrl: info.baseUrl, token: info.token }))
    .catch((cause: unknown) => {
      // The gateway spawns lazily; forget the failure so the next report retries.
      client = null;
      throw cause;
    });
  return client;
}

function report(focused: boolean): void {
  void gatewayClient()
    .then((sdk) => sdk.push.presence({ focused }))
    .catch(() => {
      // Presence is an optimisation: without it a phone gets one extra push.
    });
}

function applyFocus(focused: boolean): void {
  if (heartbeat !== null) {
    window.clearInterval(heartbeat);
    heartbeat = null;
  }
  report(focused);
  if (focused) {
    heartbeat = window.setInterval(() => report(true), HEARTBEAT_MS);
  }
}

/**
 * Reports the two inputs combined. Focus and visibility change independently
 * (a window can be hidden and restored without the OS ever reporting a focus
 * change), so both are tracked and the heartbeat follows their conjunction.
 */
function syncPresence(): void {
  const focused = windowFocused && documentVisible;
  if (focused === reportedFocus) return;
  reportedFocus = focused;
  applyFocus(focused);
}

function setWindowFocused(focused: boolean): void {
  windowFocused = focused;
  syncPresence();
}

function setDocumentVisible(visible: boolean): void {
  documentVisible = visible;
  syncPresence();
}

/**
 * Starts reporting window focus to the gateway. Safe to call once at startup;
 * repeat calls are ignored.
 */
export function startGatewayPresenceReporting(): void {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  const appWindow = getCurrentWindow();
  documentVisible = document.visibilityState === "visible";
  void appWindow
    .isFocused()
    .then((focused) => {
      setWindowFocused(focused);
      return undefined;
    })
    .catch(() => setWindowFocused(document.hasFocus()));
  void appWindow.onFocusChanged(({ payload }) => setWindowFocused(payload));
  // An occluded or minimised window can still hold OS focus, and an alert
  // behind another window is one the user has not seen. Restoring it resumes
  // the focused heartbeat, which is why this tracks both directions.
  document.addEventListener("visibilitychange", () => {
    setDocumentVisible(document.visibilityState === "visible");
  });
}
