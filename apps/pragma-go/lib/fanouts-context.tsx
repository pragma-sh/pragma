import type { Fanout } from "@pragma-sh/constants";
import { attemptWorktreeIds, fanoutForParent, memberForWorktree } from "@pragma-sh/fanout-view";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useConnection } from "./connection-context";
import { subscriptionLoop } from "./data/subscription-loop";
import { reportUnauthorized } from "./report-unauthorized";

type Client = NonNullable<ReturnType<typeof useConnection>["client"]>;

interface FanoutsContextValue {
  /** Every fanout the host knows, terminal ones included; empty until paired. */
  fanouts: Fanout[];
  /** True once the stream has delivered its first snapshot. */
  loaded: boolean;
  /**
   * The paired client, for fanout actions. Null when unpaired: there is no
   * demo fanout, because a pretend pick would be a pretend destructive action.
   */
  client: Client | null;
  /** Reports a 401 from an action the same way the streams do. */
  handleError: (error: unknown) => void;
}

const FanoutsContext = createContext<FanoutsContextValue | null>(null);

/**
 * Owns the app's single `fanouts` subscription.
 *
 * The host has no `list` action: its stream opens with a snapshot of every
 * fanout and then sends full replacements, so the subscription *is* the list.
 * One provider keeps that to one stream however many screens read it.
 */
export function FanoutsProvider({ children }: { children: ReactNode }) {
  const { client, status, handleUnauthorized } = useConnection();
  const paired = status === "paired" ? client : null;
  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFanouts([]);
    setLoaded(false);
    if (!paired) return undefined;
    const controller = new AbortController();
    void subscriptionLoop(controller.signal, handleUnauthorized, async (onDelivered) => {
      for await (const event of paired.fanouts.subscribe({ signal: controller.signal })) {
        onDelivered();
        setFanouts(event.payload.fanouts);
        setLoaded(true);
      }
    });
    return () => controller.abort();
  }, [handleUnauthorized, paired]);

  const value = useMemo<FanoutsContextValue>(
    () => ({
      fanouts,
      loaded,
      client: paired,
      handleError: (error: unknown) => reportUnauthorized(error, handleUnauthorized),
    }),
    [fanouts, handleUnauthorized, loaded, paired],
  );

  return <FanoutsContext.Provider value={value}>{children}</FanoutsContext.Provider>;
}

function useFanoutsContext(): FanoutsContextValue {
  const value = useContext(FanoutsContext);
  if (!value) throw new Error("useFanouts must be used within a FanoutsProvider");
  return value;
}

/** Every fanout on the host, plus the client and error reporting for actions. */
export function useFanouts(): FanoutsContextValue {
  return useFanoutsContext();
}

/** One fanout by id, or undefined until the stream delivers it. */
export function useFanout(fanoutId: string): Fanout | undefined {
  const { fanouts } = useFanoutsContext();
  return useMemo(() => fanouts.find((fanout) => fanout.id === fanoutId), [fanoutId, fanouts]);
}

/**
 * The fanout grouping a worktree list needs: which worktree ids are attempts
 * (and so belong under a group row rather than as plain rows), and the active
 * fanout each parent owns.
 */
export function useFanoutGrouping(): {
  attemptIds: Set<string>;
  fanoutForParent: (worktreeId: string) => Fanout | null;
  memberForWorktree: (worktreeId: string) => ReturnType<typeof memberForWorktree>;
} {
  const { fanouts } = useFanoutsContext();
  return useMemo(
    () => ({
      attemptIds: attemptWorktreeIds(fanouts),
      fanoutForParent: (worktreeId: string) => fanoutForParent(fanouts, worktreeId),
      memberForWorktree: (worktreeId: string) => memberForWorktree(fanouts, worktreeId),
    }),
    [fanouts],
  );
}
