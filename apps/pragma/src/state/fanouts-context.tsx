import type {
  Fanout,
  FanoutCreateRequest,
  FanoutPickResult,
  FanoutResult,
  FanoutSendResult,
} from "@pragma/constants";
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fanoutRpc, listFanouts, onFanouts, pickFanoutMember } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

/**
 * The desktop's view of the host's fanouts.
 *
 * State lives on the host: this provider reads the durable record and follows
 * its snapshot-then-delta stream. Nothing is orchestrated here — the same
 * fanout advances whether this window is open, closed, or reloading.
 */
export interface FanoutsContextValue {
  fanouts: Fanout[];
  /** Which fanout the comparison workspace is showing, if any. */
  comparingFanoutId: string | null;
  openComparison: (fanoutId: string) => void;
  closeComparison: () => void;
  create: (request: FanoutCreateRequest) => Promise<FanoutResult>;
  retry: (fanoutId: string, memberId: string) => Promise<FanoutResult>;
  cancel: (fanoutId: string) => Promise<FanoutResult>;
  send: (fanoutId: string, memberId: string | null, message: string) => Promise<FanoutSendResult>;
  pick: (fanoutId: string, memberId: string) => Promise<FanoutPickResult>;
}

const FanoutsContext = createContext<FanoutsContextValue | null>(null);

export function FanoutsProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const projectId = workspace.selectedProjectId;
  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [comparingFanoutId, setComparingFanoutId] = useState<string | null>(null);

  // One read for the current state, then the host's stream. The read matters on
  // its own: a window opened after a fanout was created from a terminal has
  // nothing to replay from.
  useEffect(() => {
    if (!projectId) {
      setFanouts([]);
      return;
    }
    let cancelled = false;
    void listFanouts(projectId)
      .then((current) => {
        if (!cancelled) setFanouts(current);
        return current;
      })
      .catch(() => undefined);
    let unlisten: (() => void) | null = null;
    void onFanouts((next) => {
      if (!cancelled) setFanouts(next);
    })
      .then((stop) => {
        unlisten = stop;
        if (cancelled) stop();
        return stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [projectId]);

  // A fanout that finished (or was cancelled) is no longer comparable.
  useEffect(() => {
    if (!comparingFanoutId) return;
    const current = fanouts.find((fanout) => fanout.id === comparingFanoutId);
    if (!current || current.status === "completed" || current.status === "cancelled") {
      setComparingFanoutId(null);
    }
  }, [comparingFanoutId, fanouts]);

  const rpc = useCallback(
    async <T,>(payload: Record<string, unknown>): Promise<T> => {
      if (!projectId) throw new Error("No project is selected.");
      return fanoutRpc<T>(projectId, payload);
    },
    [projectId],
  );

  const value = useMemo<FanoutsContextValue>(
    () => ({
      fanouts,
      comparingFanoutId,
      openComparison: setComparingFanoutId,
      closeComparison: () => setComparingFanoutId(null),
      create: (request) => rpc<FanoutResult>({ action: "create", ...request }),
      retry: (fanoutId, memberId) => rpc<FanoutResult>({ action: "retry", fanoutId, memberId }),
      cancel: (fanoutId) => rpc<FanoutResult>({ action: "cancel", fanoutId }),
      send: (fanoutId, memberId, message) =>
        rpc<FanoutSendResult>({
          action: "send",
          fanoutId,
          target: memberId ? { kind: "member", memberId } : { kind: "all" },
          message,
        }),
      pick: async (fanoutId, memberId) => {
        if (!projectId) throw new Error("No project is selected.");
        return pickFanoutMember(projectId, fanoutId, memberId);
      },
    }),
    [comparingFanoutId, fanouts, projectId, rpc],
  );

  return <FanoutsContext value={value}>{children}</FanoutsContext>;
}

/** Fanout state and actions for the current project. */
export function useFanouts(): FanoutsContextValue {
  const value = use(FanoutsContext);
  if (!value) {
    throw new Error("useFanouts must be used inside a FanoutsProvider");
  }
  return value;
}
