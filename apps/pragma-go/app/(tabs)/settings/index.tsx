import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useConnection } from "@/lib/connection-context";
import { checkHeartbeat, heartbeatSummary, type HeartbeatState } from "@/lib/heartbeat";

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
        <UnpairCard host={hostName ?? config?.url ?? null} />
      </ScrollView>
    </View>
  );
}

/** Round-trips `/v1/health` and shows what came back. */
function HeartbeatCard() {
  const { client } = useConnection();
  const [state, setState] = useState<HeartbeatState>({ kind: "idle" });
  const summary = heartbeatSummary(state);

  const run = () => {
    if (!client) return;
    setState({ kind: "checking" });
    void checkHeartbeat(client).then(setState);
  };

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
          className={!client || state.kind === "checking" ? "opacity-50" : undefined}
          disabled={!client || state.kind === "checking"}
          onPress={run}
          variant="secondary"
        >
          <Text>Check heartbeat</Text>
        </Button>
        {summary ? (
          <Text
            className={
              state.kind === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
            }
          >
            {summary}
          </Text>
        ) : null}
      </CardContent>
    </Card>
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
