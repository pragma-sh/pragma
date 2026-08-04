import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { listOpenPorts, type OpenPort } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

const PORT_POLL_INTERVAL_MS = 2000;
const OpenPortsContext = createContext<OpenPort[] | null>(null);

function samePorts(a: OpenPort[], b: OpenPort[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Polls host-owned listeners once for all port UI consumers. */
export function OpenPortsProvider({ children }: { children: ReactNode }) {
  const { selectedProjectId } = useWorkspace();
  const [ports, setPorts] = useState<OpenPort[]>([]);

  useEffect(() => {
    setPorts([]);
    if (!selectedProjectId) return;
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await listOpenPorts(selectedProjectId);
        if (!cancelled) setPorts((previous) => (samePorts(previous, next) ? previous : next));
      } catch {
        if (!cancelled) {
          setPorts((previous) => (previous.length === 0 ? previous : []));
        }
      } finally {
        loading = false;
      }
    };
    const refreshIfVisible = () => {
      if (!document.hidden) void refresh();
    };
    refreshIfVisible();
    const interval = window.setInterval(refreshIfVisible, PORT_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [selectedProjectId]);

  return <OpenPortsContext value={ports}>{children}</OpenPortsContext>;
}

/** Returns listeners attributable to terminal tabs in active project. */
export function useOpenPorts(): OpenPort[] {
  const ports = useContext(OpenPortsContext);
  if (ports === null) throw new Error("useOpenPorts must be used within OpenPortsProvider");
  return ports;
}
