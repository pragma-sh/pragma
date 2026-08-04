import { PragmaGatewayError, type PragmaClient } from "@pragma/sdk";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { ConnectionConfig } from "./pairing";
import {
  dropRevocations,
  livePendingRevocations,
  parsePendingRevocations,
  queueRevocation,
  type PendingRevocation,
} from "./pending-revocation";
import { createRegistrationGate } from "./registration-gate";

/** Whether push registration succeeded, and why it did not when it did not. */
export type PushRegistration =
  | { ok: true; token: string }
  | { ok: false; reason: "denied" | "unsupported" | "failed" | "cancelled" };

/** Orders registration against the revocation that unpairing sends after it. */
const registrationGate = createRegistrationGate();

/**
 * How long a revocation waits for an in-flight registration before cancelling
 * it. Long enough for a healthy host to answer, short enough that unpairing
 * does not hang on one that has gone away.
 */
const REGISTRATION_SETTLE_MS = 5_000;

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
 *
 * Pass `signal` to cancel a registration the caller no longer wants (the paired
 * screen going away, for instance). The registration also runs through the gate
 * {@link unregisterFromPush} waits on, so it can never land after the unpair
 * that was meant to end it.
 */
export function registerForPush(
  client: PragmaClient,
  options: { signal?: AbortSignal } = {},
): Promise<PushRegistration> {
  return registrationGate.run((signal) => registerToken(client, signal), options.signal);
}

async function registerToken(client: PragmaClient, signal: AbortSignal): Promise<PushRegistration> {
  const projectId = easProjectId();
  // Without an EAS project there is no push service to mint a token from.
  if (!projectId) return { ok: false, reason: "unsupported" };
  if (!(await ensurePermission())) return { ok: false, reason: "denied" };
  try {
    const token = await expoPushToken(projectId);
    // Minting cannot be aborted, so re-check before the request that would
    // register a token the caller has since given up on.
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    await client.push.register({ token }, { signal });
    return { ok: true, token };
  } catch {
    // A simulator without push entitlements, or an unreachable host: the app
    // works, it just will not be woken for alerts.
    return { ok: false, reason: signal.aborted ? "cancelled" : "failed" };
  }
}

async function expoPushToken(projectId: string): Promise<string> {
  if (Platform.OS === "android") await ensureAndroidChannel();
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

/** Where credentials for an unacknowledged revocation wait for a retry. */
const REVOCATION_STORE_KEY = "pragma.push-revocation.v1";

/**
 * Stops the host pushing to this device. Called when the user unpairs.
 *
 * Unpairing has to work with the host unreachable, but a revocation that is
 * simply dropped leaves the host sending agent-alert contents to a phone that
 * is no longer paired and can no longer ask it to stop. So a failed revocation
 * keeps this host's credentials queued, and {@link flushPendingRevocations}
 * retries on the next launch.
 *
 * A registration still in flight is waited on (then cancelled) first: a
 * `POST /v1/push/tokens` that reached the host after this `DELETE` would
 * re-register the token and resume delivery to a phone that just unpaired.
 */
export async function unregisterFromPush(
  client: PragmaClient,
  config: ConnectionConfig,
): Promise<void> {
  await registrationGate.settle(REGISTRATION_SETTLE_MS);
  try {
    await client.push.unregister();
    await forgetPendingRevocations(config.url);
  } catch {
    await queuePendingRevocation(config);
  }
}

/**
 * Retries revocations an earlier unpair could not deliver. Call at startup,
 * before pairing, so a host that was unreachable at unpair time still stops
 * pushing as soon as the phone can reach it again.
 */
export async function flushPendingRevocations(
  clientFor: (config: ConnectionConfig) => Promise<PragmaClient>,
): Promise<void> {
  const pending = livePendingRevocations(await readPendingRevocations(), Date.now());
  if (pending.length === 0) return;
  const revoked = await Promise.all(
    pending.map((entry) => retryRevocation(entry.config, clientFor)),
  );
  await writePendingRevocations(pending.filter((_, index) => !revoked[index]));
}

/** Forgets queued revocations for a host, e.g. once it is paired again. */
export async function forgetPendingRevocations(url: string): Promise<void> {
  const pending = await readPendingRevocations();
  if (!pending.some((entry) => entry.config.url === url)) return;
  await writePendingRevocations(dropRevocations(pending, url));
}

/** True once the host has confirmed (or can never confirm) the revocation. */
async function retryRevocation(
  config: ConnectionConfig,
  clientFor: (config: ConnectionConfig) => Promise<PragmaClient>,
): Promise<boolean> {
  try {
    await (await clientFor(config)).push.unregister();
    return true;
  } catch (error) {
    // A rejected token can never revoke anything, so retrying it forever only
    // keeps dead credentials on the device: give up and let the host expire the
    // registration when Expo reports the token dead.
    return error instanceof PragmaGatewayError && error.httpStatus === 401;
  }
}

async function queuePendingRevocation(config: ConnectionConfig): Promise<void> {
  const pending = await readPendingRevocations();
  await writePendingRevocations(queueRevocation(pending, config, Date.now()));
}

async function readPendingRevocations(): Promise<PendingRevocation[]> {
  const raw = await SecureStore.getItemAsync(REVOCATION_STORE_KEY).catch(() => null);
  return parsePendingRevocations(raw);
}

async function writePendingRevocations(pending: PendingRevocation[]): Promise<void> {
  const write =
    pending.length === 0
      ? SecureStore.deleteItemAsync(REVOCATION_STORE_KEY)
      : SecureStore.setItemAsync(REVOCATION_STORE_KEY, JSON.stringify(pending));
  await write.catch(() => undefined);
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

type EasProjectSource = { projectId?: string } | null | undefined;

function easProjectId(): string | undefined {
  return (
    projectIdOf(Constants.easConfig) ??
    projectIdOf((Constants.expoConfig?.extra as { eas?: EasProjectSource } | undefined)?.eas)
  );
}

function projectIdOf(source: EasProjectSource): string | undefined {
  return source?.projectId;
}
