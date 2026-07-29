import { type KeyboardEvent, useCallback } from "react";

import { useZoom, ZoomMode, type ZoomScope } from "@embedpdf/plugin-zoom/react";

/**
 * Zoom keys, by the `key` they arrive as. `=` is here because it is the
 * unshifted key most keyboards print `+` on.
 */
const ZOOM_SHORTCUTS: Record<string, (zoom: ZoomScope) => void> = {
  "+": (zoom) => zoom.zoomIn(),
  "=": (zoom) => zoom.zoomIn(),
  "-": (zoom) => zoom.zoomOut(),
  "0": (zoom) => zoom.requestZoom(1),
  "9": (zoom) => zoom.requestZoom(ZoomMode.FitWidth),
};

/**
 * ⌘/Ctrl with `+`, `-`, `0`, or `9` for zoom in, zoom out, actual size, and fit
 * width. Returned as a handler rather than a window listener so the shortcuts
 * only fire for the focused viewer — several PDFs can be open in split panes.
 */
export function usePdfZoomShortcuts(documentId: string): (event: KeyboardEvent) => void {
  const { provides } = useZoom(documentId);

  return useCallback(
    (event: KeyboardEvent) => {
      if (!provides || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const zoom = ZOOM_SHORTCUTS[event.key];
      if (!zoom) return;
      event.preventDefault();
      zoom(provides);
    },
    [provides],
  );
}
