import { useSyncExternalStore } from "react";

import { createExternalStore } from "@/lib/external-store";

/**
 * Whether the in-app computer-use panel is minimized to its pill. Shared so
 * the sidebar's computer-use badge can bring the panel back from anywhere.
 */
const store = createExternalStore(false);

/** Minimizes the panel to its pill. */
export function minimizeComputerPip(): void {
  store.set(true);
}

/** Shows the full panel again. */
export function revealComputerPip(): void {
  store.set(false);
}

/** Whether the panel is minimized. */
export function useComputerPipMinimized(): boolean {
  return useSyncExternalStore(store.subscribe, store.get);
}
