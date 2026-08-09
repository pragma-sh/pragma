// Expo resolves this browser-only module through platform extensions; fallow cannot trace it.
// fallow-ignore-file unused-file
import { useWindowDimensions } from "react-native";

/**
 * Width at which contextual web sidebar navigation becomes available.
 *
 * 768pt is a portrait iPad and roughly a small laptop window: the point at
 * which a list and its detail both fit without either feeling cramped. Below
 * it, one column is the honest layout.
 */
const WIDE_LAYOUT_BREAKPOINT = 768;

/**
 * Whether the window is wide enough for the sidebar layout. Driven by window
 * size rather than device class so a resized browser window, a slid-over iPad
 * app, and a phone in landscape all get the layout that actually fits.
 */
// fallow-ignore-next-line unused-export -- Expo resolves .web imports at runtime.
export function useWideLayout(): boolean {
  return useWindowDimensions().width >= WIDE_LAYOUT_BREAKPOINT;
}
