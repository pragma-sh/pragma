import type { PragmaClient } from "@pragma/sdk";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/** Whether push registration succeeded, and why it did not when it did not. */
export type PushRegistration =
  | { ok: true; token: string }
  | { ok: false; reason: "denied" | "unsupported" | "failed" };

// Expo push notifications for agent alerts. The host gateway watches its agent
// stream and sends the same wording the desktop toast uses; this module only
// registers the device's token and turns a tap into navigation.

/** Shows alerts while the app is foregrounded instead of dropping them. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
  });
}

/**
 * Asks for notification permission and registers this device's Expo push token
 * with the paired host. Safe to call on every launch: Expo returns the same
 * token, and the host treats a repeat registration as a refresh.
 */
export async function registerForPush(client: PragmaClient): Promise<PushRegistration> {
  const projectId = easProjectId();
  // Without an EAS project there is no push service to mint a token from.
  if (!projectId) return { ok: false, reason: "unsupported" };
  if (!(await ensurePermission())) return { ok: false, reason: "denied" };
  try {
    const token = await expoPushToken(projectId);
    await client.push.register({ token });
    return { ok: true, token };
  } catch {
    // A simulator without push entitlements, or an unreachable host: the app
    // works, it just will not be woken for alerts.
    return { ok: false, reason: "failed" };
  }
}

async function expoPushToken(projectId: string): Promise<string> {
  if (Platform.OS === "android") await ensureAndroidChannel();
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

/** Stops the host pushing to this device. Called when the user unpairs. */
export async function unregisterFromPush(client: PragmaClient): Promise<void> {
  try {
    await client.push.unregister();
  } catch {
    // Best effort: the host also drops tokens Expo reports as dead.
  }
}

async function ensurePermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Android needs a channel before a notification can make any sound. */
async function ensureAndroidChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync("agent-alerts", {
    name: "Agent alerts",
    importance: Notifications.AndroidImportance.HIGH,
  });
}

function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return Constants.easConfig?.projectId ?? extra?.eas?.projectId;
}
