import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useConnection } from "@/lib/connection-context";
import { checkHeartbeat, heartbeatSummary, type HeartbeatState } from "@/lib/heartbeat";
import {
  pushCheckSummary,
  registrationFailure,
  testOutcome,
  type PushCheckState,
} from "@/lib/push-check";
import { registerForPush } from "@/lib/push";

/** Settings tab: the host connection and the checks that act on it. */
export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { hostName, config } = useConnection();

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="border-b border-border px-4 pb-3 pt-4">
        <Text className="text-4xl font-bold text-foreground">Settings</Text>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <HeartbeatCard />
        <NotificationsCard />
        <UnpairCard host={hostName ?? config?.url ?? null} />
      </ScrollView>
    </View>
  );
}

/** Round-trips `/v1/health` and shows what came back. */
function HeartbeatCard() {
  const { busy, run, state } = useHeartbeat();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server heartbeat</CardTitle>
        <CardDescription>
          Ask the paired desktop whether its gateway is answering, and how fast.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <Button
          className={busy ? "opacity-50" : undefined}
          disabled={busy}
          onPress={run}
          variant="secondary"
        >
          <Text>Check heartbeat</Text>
        </Button>
        <HeartbeatSummary state={state} />
      </CardContent>
    </Card>
  );
}

/** The heartbeat's state plus the action that refreshes it. */
function useHeartbeat() {
  const { client } = useConnection();
  const [state, setState] = useState<HeartbeatState>({ kind: "idle" });

  const run = () => {
    if (!client) return;
    setState({ kind: "checking" });
    void checkHeartbeat(client).then(setState);
  };

  return { busy: !client || state.kind === "checking", run, state };
}

/** The heartbeat's one-line result, in the destructive tone when it failed. */
function HeartbeatSummary({ state }: { state: HeartbeatState }) {
  const summary = heartbeatSummary(state);
  if (!summary) return null;
  return (
    <Text
      className={
        state.kind === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {summary}
    </Text>
  );
}

/**
 * Registers this device for agent alerts and asks the host to push one back.
 *
 * Push is silent in several unrelated ways — permission, a build with no push
 * service, a host with nothing registered, a push service that refuses the
 * message — and none of them surface anywhere else, so this is the one place
 * that names which one is in play.
 */
function NotificationsCard() {
  const { busy, run, state } = usePushCheck();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Agent alerts arrive as notifications while Pragma Go is closed. The desktop holds them
          back while its own window is in front.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <Button
          className={busy ? "opacity-50" : undefined}
          disabled={busy}
          onPress={run}
          variant="secondary"
        >
          <Text>Send a test notification</Text>
        </Button>
        <PushSummary state={state} />
      </CardContent>
    </Card>
  );
}

/** The notification check's state plus the action that runs it. */
function usePushCheck() {
  const { client } = useConnection();
  const [state, setState] = useState<PushCheckState>({ kind: "idle" });

  const run = () => {
    if (!client) return;
    setState({ kind: "checking" });
    void runPushCheck(client).then(setState);
  };

  return { busy: !client || state.kind === "checking", run, state };
}

/** Registers (or refreshes) this device, then asks the host to push to it. */
async function runPushCheck(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
): Promise<PushCheckState> {
  if (Platform.OS === "web") {
    return registrationFailure({ ok: false, reason: "unsupported" }) ?? { kind: "idle" };
  }
  const registration = await registerForPush(client);
  const failure = registrationFailure(registration);
  if (failure) return failure;
  try {
    return testOutcome(await client.push.test());
  } catch {
    return { kind: "failed", reason: "The desktop couldn't send a test notification." };
  }
}

/** The check's one-line result, in the destructive tone when it failed. */
function PushSummary({ state }: { state: PushCheckState }) {
  const summary = pushCheckSummary(state);
  if (!summary) return null;
  return (
    <Text
      className={
        state.kind === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {summary}
    </Text>
  );
}

/**
 * Forgets the paired host. Confirmation is a second press rather than an
 * `Alert`, because React Native Web's `Alert` drops the button callbacks — the
 * destructive action would run unconfirmed in the browser.
 */
function UnpairCard({ host }: { host: string | null }) {
  const { unpair } = useConnection();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pairing</CardTitle>
        <CardDescription>
          {host
            ? `This device is paired with ${host}.`
            : "This device is paired with a desktop host."}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <Button
          onPress={() => (confirming ? void unpair() : setConfirming(true))}
          variant="destructive"
        >
          <Text>{confirming ? "Confirm unpair" : "Unpair this device"}</Text>
        </Button>
        {confirming ? (
          <>
            <Text className="text-sm text-muted-foreground">
              Unpairing clears the stored token and stops notifications. You will need the desktop's
              pairing code to connect again.
            </Text>
            <Button onPress={() => setConfirming(false)} variant="ghost">
              <Text>Cancel</Text>
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
