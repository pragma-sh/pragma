import { useCallback, useEffect, useRef, useState } from "react";

import type { ComputerPermissionKind, ComputerPermissions } from "@pragma-sh/constants";

import { errorMessage } from "@/lib/errors";
import { computerRpc } from "@/lib/tauri";

const PERMISSION_POLL_MS = 2_000;

/** Checks grants without prompting; only an explicit button press requests access. */
export function useComputerPermissions({
  enabled = true,
  pollWhileGranted = false,
}: { enabled?: boolean; pollWhileGranted?: boolean } = {}) {
  const [permissions, setPermissions] = useState<ComputerPermissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<ComputerPermissionKind | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(
    async (permission?: ComputerPermissionKind) => {
      // Focus changes and polling must not queue behind an open native prompt.
      if (!enabled || inFlight.current) return;
      inFlight.current = true;
      if (permission) setRequesting(permission);
      try {
        const next = await computerRpc<ComputerPermissions>({
          op: "permissions",
          ...(permission ? { request: true, permission } : {}),
        });
        setPermissions(next);
        setError(null);
      } catch (cause) {
        setError(`Could not check permissions: ${errorMessage(cause)}`);
      } finally {
        inFlight.current = false;
        setRequesting(null);
      }
    },
    [enabled],
  );

  const needsPermissions =
    permissions?.supported === true &&
    permissions.platform === "macos" &&
    (permissions.accessibility !== "granted" || permissions.screenRecording !== "granted");

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void load();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || (permissions !== null && !needsPermissions && !error && !pollWhileGranted))
      return;
    const timer = window.setInterval(() => void load(), PERMISSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, load, permissions, needsPermissions, error, pollWhileGranted]);

  return { permissions, needsPermissions, error, requesting, load };
}
