import { useEffect } from "react";

/**
 * Runs a contribution's count hook and reports each result to `onCount`;
 * renders nothing. Mounting the hook in its own component keeps the rules of
 * hooks intact however many counted contributions come and go, and lets a
 * parent show a badge for a body it has not mounted. Unmounting reports `null`.
 */
export function CountProbe<TArgs extends unknown[]>({
  useCount,
  args,
  onCount,
}: {
  useCount: (...args: TArgs) => number | null;
  args: TArgs;
  onCount: (count: number | null) => void;
}): null {
  const count = useCount(...args);
  useEffect(() => {
    onCount(count);
  }, [count, onCount]);
  useEffect(() => () => onCount(null), [onCount]);
  return null;
}
