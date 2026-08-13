import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { renderSVG } from "uqr";

import { constants } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { errorMessage } from "@/lib/errors";
import { buildWebAppUrl, encodePairingPayload } from "@/lib/pairing";
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

  return {
    status,
    token,
    hostName,
    busy,
    error,
    refreshStatus,
    toggleRemote,
    regenerateToken,
  };
}

/** Mobile and browser pairing cards used by the full-frame Settings workspace. */
export function PragmaGoSettings({
  webEnabled,
  onWebEnabledChange,
}: {
  webEnabled: boolean;
  onWebEnabledChange: (enabled: boolean) => void;
}) {
  const { status, token, hostName, busy, error, toggleRemote, regenerateToken } =
    usePairingTunnel(true);
  const enabled = status.state === "active" || status.state === "starting";
  const url = status.state === "active" ? status.value : "";

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Pair mobile device"
        description="Expose this host through the configured tunnel and scan from Pragma Go."
      >
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="settings-remote-access">Remote access</Label>
            <p className="text-xs text-muted-foreground">{tunnelHint(status)}</p>
          </div>
          <Switch
            id="settings-remote-access"
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) => void toggleRemote(next)}
          />
        </div>
        {status.state === "error" ? (
          <p className="mt-3 text-sm text-destructive">{status.value}</p>
        ) : null}
        {url ? <PairingQr url={url} token={token} hostName={hostName} /> : null}
        {status.state === "starting" ? (
          <p className="mt-4 text-center text-sm text-muted-foreground">Starting tunnel…</p>
        ) : null}
        {url ? (
          <ManualSection url={url} token={token} onRegenerate={regenerateToken} busy={busy} />
        ) : null}
      </SettingsCard>
      <SettingsCard
        title="Pair Pragma Go on web"
        description="Open Pragma Go in a browser on another computer."
      >
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="settings-web-access">Enable web access</Label>
            <p className="text-xs text-muted-foreground">
              Serve Pragma Go from this host's gateway.
            </p>
          </div>
          <Switch
            id="settings-web-access"
            checked={webEnabled}
            onCheckedChange={onWebEnabledChange}
          />
        </div>
        {webEnabled && url ? <WebAppSection url={url} token={token} /> : null}
        {webEnabled && !url ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Turn on remote access to create a web pairing link.
          </p>
        ) : null}
      </SettingsCard>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
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

/**
 * The browser route into the same host: Pragma Go, served by the gateway over
 * the tunnel. Shown as a copyable link rather than a second QR — this one is
 * meant to be pasted into a browser on another computer, not scanned.
 */
function WebAppSection({ url, token }: { url: string; token: string }) {
  return (
    <div className="mt-4 space-y-1">
      <CopyRow label="Web app link" value={buildWebAppUrl(url, token)} />
      <p className="text-xs text-muted-foreground">
        Opens Pragma Go in a browser, already signed in. The link contains the token — treat it like
        a password, and regenerate the token above if it leaks.
      </p>
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
