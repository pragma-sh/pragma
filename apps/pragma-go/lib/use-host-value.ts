import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "./connection-context";
import { reportUnauthorized } from "./report-unauthorized";

/** The paired client a host read runs against. */
export type HostClient = NonNullable<ReturnType<typeof useConnection>["client"]>;

/** One host read and how it went. */
export interface HostValue<T> {
  value: T | undefined;
  error: string | null;
  loading: boolean;
  /** Reads again, keeping the current value on screen until the new one lands. */
  reload: () => void;
}

/**
 * Reads one value from the host, keyed by `key`.
 *
 * A null key means "not ready to ask yet" (the worktree path has not loaded).
 * A new key starts a fresh read and drops the previous answer, since it
 * belongs to something else; a `reload` of the same key keeps it, so a refresh
 * does not blank the screen. A 401 goes to the connection, like every stream.
 */
export function useHostValue<T>(
  key: string | null,
  load: (client: HostClient) => Promise<T>,
): HostValue<T> {
  const { client, handleUnauthorized } = useConnection();
  const [state, setState] = useState<{ key: string | null; value: T | undefined }>({
    key: null,
    value: undefined,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!client || key === null) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef
      .current(client)
      .then((value) => {
        if (!cancelled) setState({ key, value });
        return undefined;
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        reportUnauthorized(caught, handleUnauthorized);
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized, key, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { value: state.key === key ? state.value : undefined, error, loading, reload };
}
