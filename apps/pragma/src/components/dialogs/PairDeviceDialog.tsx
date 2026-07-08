import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { renderSVG } from "uqr";

import { constants } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { ModalShell } from "@/components/ui/modal-shell";
import { Switch } from "@/components/ui/switch";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { errorMessage } from "@/lib/errors";
import { encodePairingPayload } from "@/lib/pairing";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import {
  gatewayConnectionInfo,
  getAppInfo,
  regenerateGatewayToken,
  tunnelStart,
  tunnelStatus,
  tunnelStop,
  type TunnelStatus,
} from "@/lib/tauri";

/** How often the tunnel status is polled while the dialog is open. */
const STATUS_POLL_MS = 1500;

interface PairDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PairingTunnel {
  status: TunnelStatus;
  token: string;
  hostName: string;
  busy: boolean;
  error: string | null;
  refreshStatus: () => Promise<void>;
  toggleRemote: (next: boolean) => Promise<void>;
  regenerateToken: () => Promise<void>;
}

/**
 * Owns the remote-access tunnel's state: the current {@link TunnelStatus},
 * the pairing token/host name, and the on/off toggle. Loads the token + host
 * name and starts polling the tunnel status whenever `open` flips true.
 */
function usePairingTunnel(open: boolean): PairingTunnel {
  const [status, setStatus] = useState<TunnelStatus>({ state: "idle" });
  const [token, setToken] = useState("");
  const [hostName, setHostName] = useState("Pragma");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await tunnelStatus());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  // Load the gateway token + host name, and sync the tunnel state, on open.
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [info, appInfo] = await Promise.all([gatewayConnectionInfo(), getAppInfo()]);
        if (cancelled) {
          return;
        }
        setToken(info.token);
        setHostName(appInfo.name);
      } catch (cause) {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      }
    })();
    void refreshStatus();
    return () => {
      cancelled = true;
    };
  }, [open, refreshStatus]);

  // Poll the tunnel status while open so the switch + QR track the live state.
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [open, refreshStatus]);

  async function toggleRemote(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(next ? await tunnelStart() : (await tunnelStop(), { state: "idle" }));
    } catch (cause) {
      setError(errorMessage(cause));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function regenerateToken(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const info = await regenerateGatewayToken();
      setToken(info.token);
      await refreshStatus();
      toast.success("Gateway token regenerated. Paired devices must reconnect.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return { status, token, hostName, busy, error, refreshStatus, toggleRemote, regenerateToken };
}

/**
 * Pair-a-device modal: flips the remote-access tunnel on/off and renders a QR
 * of the {@link PairingPayload} (public URL + gateway token) for a phone to
 * scan. The tunnel deliberately survives the modal closing — closing does not
 * stop it — so users can pair, close, and re-open without dropping devices.
 */
export function PairDeviceDialog({ open, onOpenChange }: PairDeviceDialogProps) {
  useEscapeToClose(open, () => onOpenChange(false));
  useSuppressNativeOverlayWhile(open);
  const { status, token, hostName, busy, error, toggleRemote, regenerateToken } =
    usePairingTunnel(open);

  if (!open) {
    return null;
  }

  const enabled = status.state === "active" || status.state === "starting";
  const url = status.state === "active" ? status.value : "";

  return (
    <ModalShell>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Pair a device</h2>
        <p className="text-sm text-muted-foreground">
          Expose this host over a secure tunnel and scan the code from the Pragma mobile app.
        </p>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="remote-access">Remote access</Label>
          <p className="text-xs text-muted-foreground">{tunnelHint(status)}</p>
        </div>
        <Switch
          id="remote-access"
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => void toggleRemote(next)}
        />
      </div>

      {status.state === "error" ? (
        <p className="mt-3 text-sm text-destructive">{status.value}</p>
      ) : null}

      {url ? (
        <PairingQr url={url} token={token} hostName={hostName} />
      ) : status.state === "starting" ? (
        <p className="mt-4 text-center text-sm text-muted-foreground">Starting tunnel…</p>
      ) : null}

      {url ? (
        <ManualSection url={url} token={token} onRegenerate={regenerateToken} busy={busy} />
      ) : null}

      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      <div className="mt-5 flex justify-end">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    </ModalShell>
  );
}

function tunnelHint(status: TunnelStatus): string {
  switch (status.state) {
    case "active":
      return "This host is reachable over the tunnel.";
    case "starting":
      return "Starting the tunnel…";
    case "error":
      return "The tunnel failed to start.";
    case "idle":
      return "Turn on to expose this host to a paired device.";
  }
}

interface PairingQrProps {
  url: string;
  token: string;
  hostName: string;
}

/** Renders the pairing payload as an inline SVG QR code (uqr, fully offline). */
function PairingQr({ url, token, hostName }: PairingQrProps) {
  const svg = renderSVG(
    encodePairingPayload({
      url,
      token,
      protocolVersion: constants.daemon.protocolVersion,
      hostName,
    }),
  );
  return (
    <div className="mt-4 flex justify-center">
      <div
        className="rounded-lg bg-white p-3 [&>svg]:h-48 [&>svg]:w-48"
        // uqr emits a self-contained, static SVG string from local data only.
        // eslint-disable-next-line react/no-danger -- offline-generated QR SVG, no user HTML
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

interface ManualSectionProps {
  url: string;
  token: string;
  onRegenerate: () => Promise<void>;
  busy: boolean;
}

/** Collapsible manual-entry fallback: copyable URL + token and token reset. */
function ManualSection({ url, token, onRegenerate, busy }: ManualSectionProps) {
  return (
    <Collapsible className="mt-4">
      <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronDown className="size-4" />
        Manual
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3">
        <CopyRow label="URL" value={url} />
        <CopyRow label="Token" value={token} mono />
        <div className="space-y-1">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onRegenerate()}>
            <RefreshCw className="size-4" />
            Regenerate token
          </Button>
          <p className="text-xs text-muted-foreground">
            Paired devices disconnect until they re-pair.
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface CopyRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function CopyRow({ label, value, mono }: CopyRowProps) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 text-xs ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
        <Button
          aria-label={`Copy ${label}`}
          size="icon-sm"
          variant="ghost"
          onClick={() => void copy()}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}
