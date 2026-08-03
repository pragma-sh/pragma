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
 * Starts reporting window focus to the gateway. Safe to call once at startup;
 * repeat calls are ignored.
 */
export function startGatewayPresenceReporting(): void {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  const appWindow = getCurrentWindow();
  void appWindow
    .isFocused()
    .then((focused) => {
      applyFocus(focused && document.visibilityState === "visible");
      return undefined;
    })
    .catch(() => applyFocus(document.hasFocus()));
  void appWindow.onFocusChanged(({ payload }) => applyFocus(payload));
  // An occluded or minimised window can still hold OS focus, and an alert
  // behind another window is one the user has not seen.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      applyFocus(false);
    }
  });
}
