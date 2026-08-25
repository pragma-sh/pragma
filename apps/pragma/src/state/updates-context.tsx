import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { constants, type OtherSettings } from "@pragma/constants";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRequiredContext } from "@/lib/context";
import { errorMessage } from "@/lib/errors";
import {
  applyUpdate,
  checkForUpdate,
  confirmUiOverlay,
  getUpdateRuntime,
  readConfig,
  type UpdateCheck,
  type UpdateRuntime,
} from "@/lib/tauri";

interface UpdatesContextValue {
  runtime: UpdateRuntime | null;
  offer: UpdateCheck | null;
  checking: boolean;
  applying: boolean;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
}

const UpdatesContext = createContext<UpdatesContextValue | null>(null);

/**
 * Polls the update check API, holds the current offer, and owns the restart
 * confirmation modal. Dev instances default to localhost:3000; production uses
 * shipped pragma-app.sh URL unless Settings overrides `other.serverUrl`.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<UpdateRuntime | null>(null);
  const [offer, setOffer] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const settingsRef = useRef<OtherSettings>({});

  useEffect(() => {
    void confirmUiOverlay().catch(() => undefined);
  }, []);

  const loadSettings = useCallback(async (): Promise<OtherSettings> => {
    try {
      const document = await readConfig("global");
      const parsed = JSON.parse(document.contents) as {
        other?: OtherSettings;
        updates?: { checkUrl?: string; autoDownload?: boolean };
      };
      const next =
        parsed.other ??
        ({
          serverUrl: parsed.updates?.checkUrl,
          autoDownload: parsed.updates?.autoDownload,
        } satisfies OtherSettings);
      settingsRef.current = next;
      return next;
    } catch {
      settingsRef.current = {};
      return {};
    }
  }, []);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const [nextRuntime, settings] = await Promise.all([getUpdateRuntime(), loadSettings()]);
      setRuntime(nextRuntime);
      const url = effectiveCheckUrl(settings, nextRuntime);
      const next = await checkForUpdate(url);
      setOffer(next.available ? next : null);
    } catch (cause) {
      setOffer(null);
      toast.error(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }, [loadSettings]);

  const applyOffer = useCallback(async (current: UpdateCheck) => {
    if (
      !current.apply ||
      !current.version ||
      !current.asset ||
      current.manifestJson === undefined ||
      current.manifestSignature === undefined
    ) {
      toast.error("Update is missing an asset.");
      return;
    }
    setApplying(true);
    try {
      const result = await applyUpdate({
        apply: current.apply,
        version: current.version,
        asset: current.asset,
        manifestJson: current.manifestJson,
        manifestSignature: current.manifestSignature,
      });
      if (result.mode === "reload") {
        toast.success("UI update applied. Reloading…", changelogAction(current.changelogUrl));
        if (!result.url) throw new Error("UI update did not return its reload URL.");
        window.location.replace(result.url);
        return;
      }
      toast.success(
        "Installer opened. Finish it, then relaunch Pragma.",
        changelogAction(current.changelogUrl),
      );
      setRestartOpen(false);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setApplying(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!offer?.available || !offer.apply) return;
    if (offer.apply === "restart") {
      setRestartOpen(true);
      return;
    }
    await applyOffer(offer);
  }, [applyOffer, offer]);

  useEffect(() => {
    void (async () => {
      const [nextRuntime, settings] = await Promise.all([getUpdateRuntime(), loadSettings()]);
      setRuntime(nextRuntime);
      const autoDownload = settings.autoDownload ?? constants.updates.autoDownload;
      if (autoDownload) void checkNow();
    })();
  }, [checkNow, loadSettings]);

  useEffect(() => {
    const intervalMs = constants.updates.pollIntervalMs;
    const timer = window.setInterval(() => {
      const autoDownload = settingsRef.current.autoDownload ?? constants.updates.autoDownload;
      if (autoDownload) void checkNow();
    }, intervalMs);
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      const autoDownload = settingsRef.current.autoDownload ?? constants.updates.autoDownload;
      if (autoDownload) void checkNow();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkNow]);

  useEffect(() => {
    function onConfig() {
      void loadSettings();
    }
    window.addEventListener("pragma:config-changed", onConfig);
    return () => window.removeEventListener("pragma:config-changed", onConfig);
  }, [loadSettings]);

  const value = useMemo<UpdatesContextValue>(
    () => ({ runtime, offer, checking, applying, checkNow, install }),
    [applying, checkNow, checking, install, offer, runtime],
  );

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      <AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{constants.updates.restartWarningTitle}</AlertDialogTitle>
            <AlertDialogDescription>{constants.updates.restartWarningBody}</AlertDialogDescription>
          </AlertDialogHeader>
          {offer?.notes ? <p className="text-sm text-muted-foreground">{offer.notes}</p> : null}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setRestartOpen(false)}>
              Cancel
            </Button>
            <Button disabled={applying} onClick={() => offer && void applyOffer(offer)}>
              {constants.updates.buttonLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UpdatesContext.Provider>
  );
}

/** Access the desktop update poller. */
export function useUpdates(): UpdatesContextValue {
  return useRequiredContext(UpdatesContext, "UpdatesProvider");
}

function changelogAction(url: string | undefined) {
  if (!url) return undefined;
  return {
    action: {
      label: constants.updates.changelogLabel,
      onClick: () => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  };
}

function effectiveCheckUrl(settings: OtherSettings, current: UpdateRuntime): string {
  return settings.serverUrl?.trim() || current.checkUrl;
}
