import { useEffect, useRef, useState } from "react";

/**
 * Loads a value whenever `key` changes: `undefined` while the request is in
 * flight, then the resolved value — or `fallback` when it rejects. Results for a
 * superseded key, or after unmount, are dropped.
 */
export function useAsyncValue<T, F>(
  key: string,
  load: () => Promise<T>,
  fallback: F,
): T | F | undefined {
  const [value, setValue] = useState<T | F | undefined>(undefined);
  const latest = useRef({ load, fallback });
  latest.current = { load, fallback };
  useEffect(() => {
    let active = true;
    setValue(undefined);
    void latest.current
      .load()
      .then((loaded) => {
        if (active) setValue(loaded);
        return loaded;
      })
      .catch(() => {
        if (active) setValue(latest.current.fallback);
      });
    return () => {
      active = false;
    };
  }, [key]);
  return value;
}
