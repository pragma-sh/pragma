import { constants, isStaleReading, type UsageLimitsProvider } from "@pragma/constants";
import { PragmaGatewayError } from "@pragma/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { useConnection } from "./connection-context";

/** The paired host's usage providers, and how the last read went. */
export interface UsageLimits {
  providers: UsageLimitsProvider[];
  /** No read has completed yet, so it is not known whether any provider exists. */
  loading: boolean;
  /** The last read failed. Previous readings, if any, are still in `providers`. */
  failed: boolean;
  /** Re-reads from the host; the host decides whether that costs a provider call. */
  refresh: () => Promise<void>;
}

/**
 * Reads the host's usage-limit cache.
 *
 * Polling is the host's job, not the phone's: it owns the refresh cadence and
 * coalesces this request with the desktop's. So this asks on mount, when the
 * screen regains focus, when the app returns to the foreground, and when the
 * user pulls to refresh — and never on a timer while backgrounded.
 *
 * A failed read leaves the previous providers in place. An unreachable host is
 * not the same as a provider reporting no usage, and the difference has to
 * survive into what the cards render.
 */
export function useUsageLimits(root?: string): UsageLimits {
  const { client, handleUnauthorized } = useConnection();
  const [providers, setProviders] = useState<UsageLimitsProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Only the newest read may publish: a slow refresh must not overwrite the
  // result of one the user triggered afterwards.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!client) return;
    const seq = ++requestSeq.current;
    try {
      const next = await client.usageLimits.get(root ? { root } : {});
      if (seq !== requestSeq.current) return;
      setProviders(next);
      setFailed(false);
    } catch (error: unknown) {
      if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      if (seq === requestSeq.current) setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client, handleUnauthorized, root]);

  useEffect(() => {
    if (!client) {
      setProviders([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [client, refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { providers, loading, failed, refresh };
}

/** Whether a cached reading is old enough to be labelled as such. */
export function isStale(provider: UsageLimitsProvider, now: number = Date.now()): boolean {
  return isStaleReading(provider, constants.usageLimits.staleAfterMs, now);
}
