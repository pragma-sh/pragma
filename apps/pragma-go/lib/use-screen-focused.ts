import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

/**
 * Whether this screen is the one in front; false while another is pushed over
 * it. `initial` is the answer for the first render, before the focus effect runs.
 */
export function useScreenFocused(initial = false): boolean {
  const [focused, setFocused] = useState(initial);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return focused;
}
