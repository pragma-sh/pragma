import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RememberBrowserToggle } from "@/components/RememberBrowserToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { probeConnection, useConnection } from "@/lib/connection-context";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { sameScanFrame, scanFrame, type ScanFrame, type ScanViewSize } from "@/lib/scan-frame";
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
        frozen={busy}
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

/** How long a highlight survives without a fresh detection before it fades. */
const SCAN_FRAME_TTL_MS = 500;

/**
 * The camera preview, the highlight drawn around whichever QR code is in view,
 * and the freeze that holds both still while the scanned code is verified.
 * `frozen` is the pairing screen's own busy flag, so the picture the user's
 * hand was steady for is the picture they keep looking at.
 */
function CameraScanner({
  frozen,
  granted,
  onRequest,
  onScan,
}: {
  frozen: boolean;
  granted: boolean;
  onRequest: () => void;
  onScan: (raw: string) => void;
}) {
  const cameraRef = useRef<CameraView>(null);
  const [size, setSize] = useState<ScanViewSize | null>(null);
  const { frame, track } = useScanFrame(frozen);

  useFrozenPreview(cameraRef, frozen);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  const onBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      // A paused preview still delivers the frame that was in flight; ignoring
      // it keeps the frozen highlight on the code that was actually scanned.
      if (frozen) return;
      if (size) track(scanFrame(result, size));
      onScan(result.data);
    },
    [frozen, onScan, size, track],
  );

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
    <View
      className="aspect-square overflow-hidden rounded-2xl border border-border"
      onLayout={onLayout}
    >
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onBarcodeScanned}
        ref={cameraRef}
        style={{ flex: 1 }}
      />
      <ScanHighlight frame={frame} locked={frozen} />
    </View>
  );
}

/**
 * Colours for the highlight. These are deliberately literal rather than theme
 * tokens: the box is drawn over a camera image, which has no theme, and the
 * padded rectangle lands on the code's white quiet zone, where a foreground
 * colour from either scheme would be near-invisible. Sky while the scanner is
 * tracking, green once the code has been accepted.
 */
const SCAN_TRACKING_COLOR = "#38bdf8";
const SCAN_LOCKED_COLOR = "#22c55e";

/** The box drawn over the code the camera is looking at. */
function ScanHighlight({ frame, locked }: { frame: ScanFrame | null; locked: boolean }) {
  if (!frame) return null;
  return (
    <View
      className="absolute rounded-xl border-2"
      pointerEvents="none"
      style={{
        borderColor: locked ? SCAN_LOCKED_COLOR : SCAN_TRACKING_COLOR,
        height: frame.height,
        left: frame.x,
        top: frame.y,
        width: frame.width,
      }}
    />
  );
}

/**
 * Holds the highlighted rectangle. Detections arrive per camera frame, so a
 * near-identical rectangle is dropped rather than re-rendered, and one that
 * stops arriving (the code left the view) expires instead of lingering. Once
 * `frozen` is set the last rectangle is kept indefinitely — it is the whole
 * point of the freeze.
 */
function useScanFrame(frozen: boolean): {
  frame: ScanFrame | null;
  track: (next: ScanFrame | null) => void;
} {
  const [frame, setFrame] = useState<ScanFrame | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExpiry = useCallback(() => {
    if (expiry.current === null) return;
    clearTimeout(expiry.current);
    expiry.current = null;
  }, []);

  useEffect(() => clearExpiry, [clearExpiry]);

  useEffect(() => {
    if (frozen) clearExpiry();
    else setFrame(null);
  }, [clearExpiry, frozen]);

  const track = useCallback(
    (next: ScanFrame | null) => {
      setFrame((current) => (sameScanFrame(current, next) ? current : next));
      clearExpiry();
      if (next) expiry.current = setTimeout(() => setFrame(null), SCAN_FRAME_TTL_MS);
    },
    [clearExpiry],
  );

  return { frame, track };
}

/**
 * Freezes the preview on the frame the code was read from, and thaws it if
 * pairing fails and the user gets another go. `pausePreview` is a no-op on a
 * camera that has not started yet, so failures are ignored rather than
 * surfaced as a pairing error.
 */
function useFrozenPreview(cameraRef: RefObject<CameraView | null>, frozen: boolean): void {
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const settled = frozen ? camera.pausePreview() : camera.resumePreview();
    void settled.catch(() => undefined);
  }, [cameraRef, frozen]);
}
