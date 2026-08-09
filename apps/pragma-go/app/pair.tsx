import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { probeConnection, useConnection } from "@/lib/connection-context";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { isPersistent, setPersistent } from "@/lib/secret-store";
import { defaultGatewayUrl } from "@/lib/web-handoff";
import {
  parsePairingPayload,
  validateManualEntry,
  validatePairingPayload,
  type ConnectionConfig,
} from "@/lib/pairing";

/**
 * Pairing screen: scan the desktop's QR code, or fall back to typing the
 * gateway URL + token. Every candidate is validated (shape + protocol, then a
 * live reachability/token probe) before it's persisted and the app connects.
 */
export default function PairScreen() {
  const { pair } = useConnection();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // In a browser the page is served by the gateway it talks to, so the URL is
  // already known and only the token is missing.
  const [manualUrl, setManualUrl] = useState(defaultGatewayUrl);
  const [manualToken, setManualToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handledRef = useRef(false);

  async function tryPair(config: ConnectionConfig, hostName?: string): Promise<void> {
    setBusy(true);
    setError(null);
    const probe = await probeConnection(config);
    if (!probe.ok) {
      handledRef.current = false;
      setBusy(false);
      setError(probe.reason);
      hapticWarning();
      return;
    }
    hapticSuccess();
    await pair(config, hostName ?? probe.hostName);
    router.replace("/");
  }

  function onScan(raw: string): void {
    if (handledRef.current || busy) return;
    const scan = validateScan(raw);
    if (!scan.ok) {
      setError(scan.reason);
      return;
    }
    handledRef.current = true;
    void tryPair(scan.config, scan.hostName);
  }

  function onManualSubmit(): void {
    const result = validateManualEntry(manualUrl, manualToken);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    void tryPair(result.config);
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: 16,
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 24,
        gap: 20,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-sm text-muted-foreground">
        On your computer, open Pragma → Remote access to show the pairing QR code, then point your
        camera at it.
      </Text>

      <CameraScanner
        granted={permission?.granted ?? false}
        onRequest={requestPermission}
        onScan={onScan}
      />

      <PairingStatus busy={busy} error={error} />
      <RememberBrowserToggle />
      <ManualPairingForm
        busy={busy}
        onSubmit={onManualSubmit}
        setToken={setManualToken}
        setUrl={setManualUrl}
        token={manualToken}
        url={manualUrl}
      />
    </ScrollView>
  );
}

function validateScan(
  raw: string,
): { ok: true; config: ConnectionConfig; hostName?: string } | { ok: false; reason: string } {
  const payload = parsePairingPayload(raw);
  if (!payload) return { ok: false, reason: "That QR code isn't a Pragma pairing code." };
  const result = validatePairingPayload(payload);
  return result.ok ? { ok: true, config: result.config, hostName: payload.hostName } : result;
}

/**
 * Browser-only opt-in to durable token storage.
 *
 * A phone keeps its token in the OS keychain, which is private to the app. A
 * browser has no such place: the token can only live in Web Storage, and on a
 * shared or public machine that should not outlive the tab. So the default is
 * session-scoped and staying signed in is an explicit choice.
 */
function RememberBrowserToggle() {
  const [remember, setRemember] = useState(isPersistent);
  if (Platform.OS !== "web") return null;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: remember }}
      className="flex-row items-center gap-3"
      onPress={() => {
        const next = !remember;
        setPersistent(next);
        setRemember(next);
      }}
    >
      <View
        className={`h-5 w-5 items-center justify-center rounded border ${
          remember ? "border-primary bg-primary" : "border-input"
        }`}
      >
        {remember ? <Text className="text-xs text-primary-foreground">✓</Text> : null}
      </View>
      <Text className="flex-1 text-sm text-muted-foreground">
        Stay signed in on this browser. Leave off on a shared computer — the token is then forgotten
        when you close the tab.
      </Text>
    </Pressable>
  );
}

function PairingStatus({ busy, error }: { busy: boolean; error: string | null }) {
  return (
    <>
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {busy ? <Text className="text-sm text-muted-foreground">Connecting…</Text> : null}
    </>
  );
}

function ManualPairingForm({
  busy,
  onSubmit,
  setToken,
  setUrl,
  token,
  url,
}: {
  busy: boolean;
  onSubmit: () => void;
  setToken: (token: string) => void;
  setUrl: (url: string) => void;
  token: string;
  url: string;
}) {
  return (
    <View className="gap-3">
      <Text className="text-base font-semibold text-foreground">Or enter details manually</Text>
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setUrl}
        placeholder="https://your-host.ngrok.app"
        value={url}
      />
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setToken}
        placeholder="Gateway token"
        secureTextEntry
        value={token}
      />
      <Button className={busy ? "opacity-50" : undefined} disabled={busy} onPress={onSubmit}>
        <Text>Connect</Text>
      </Button>
    </View>
  );
}

function CameraScanner({
  granted,
  onRequest,
  onScan,
}: {
  granted: boolean;
  onRequest: () => void;
  onScan: (raw: string) => void;
}) {
  if (!granted) {
    return (
      <View className="items-center gap-3 rounded-2xl border border-border bg-muted/40 p-8">
        <Text className="text-center text-sm text-muted-foreground">
          Camera access is needed to scan the pairing code.
        </Text>
        <Button onPress={onRequest} variant="secondary">
          <Text>Enable camera</Text>
        </Button>
      </View>
    );
  }
  return (
    <View className="aspect-square overflow-hidden rounded-2xl border border-border">
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onScan(data)}
        style={{ flex: 1 }}
      />
    </View>
  );
}
