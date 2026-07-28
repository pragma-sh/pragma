import { useCallback, useEffect, useState } from "react";

import { readDesignPalette } from "@/lib/design-mode";
import {
  type BrowserDesignStage,
  browserDesignSet,
  type DesignPalette,
  onBrowserDesignStage,
} from "@/lib/tauri";

/** A staged change plus a stable local id, so the list can be keyed and edited. */
export interface StagedDesignChange extends BrowserDesignStage {
  id: string;
}

export interface DesignModeApi {
  /** Whether the in-page picker overlay is active for this tab. */
  enabled: boolean;
  /** Changes staged so far, in the order the user added them. */
  changes: StagedDesignChange[];
  /** Turns the picker overlay on or off. */
  setEnabled: (enabled: boolean) => void;
  /** Drops one staged change. */
  remove: (id: string) => void;
  /** Drops every staged change. */
  clear: () => void;
}

/**
 * Tracks the app's theme tokens as concrete values for the in-page overlay.
 *
 * Re-reads whenever the light/dark class or the theme override stylesheet
 * changes, so the overlay restyles with the app instead of keeping the colors
 * it was opened with.
 */
function useDesignPalette(): DesignPalette {
  const [palette, setPalette] = useState(() => readDesignPalette());
  useEffect(() => {
    const update = () =>
      setPalette((current) => {
        const next = readDesignPalette();
        return samePalette(current, next) ? current : next;
      });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return palette;
}

/** Whether two palettes resolve to the same colors (avoids redundant pushes). */
function samePalette(a: DesignPalette, b: DesignPalette): boolean {
  return (Object.keys(a) as Array<keyof DesignPalette>).every((key) => a[key] === b[key]);
}

/**
 * Drives design mode for one browser tab: the picker overlay's on/off state and
 * the list of changes staged from it.
 *
 * The overlay lives inside the native webview, so staged changes arrive as
 * `browser-design-stage` events (a cancelled sentinel navigation on the Rust
 * side) rather than as React events.
 */
export function useDesignMode(tabId: string, pageUrl: string | null | undefined): DesignModeApi {
  const [enabled, setEnabledState] = useState(false);
  const [changes, setChanges] = useState<StagedDesignChange[]>([]);
  const palette = useDesignPalette();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onBrowserDesignStage((stage) => {
      if (stage.tabId === tabId) {
        setChanges((current) => [...current, { ...stage, id: crypto.randomUUID() }]);
      }
    }).then((cleanup) => {
      if (disposed) {
        return cleanup();
      }
      unlisten = cleanup;
      return undefined;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tabId]);

  // Re-assert the flag after a navigation, and re-push the palette when the
  // theme changes. The overlay persists both in the page's `sessionStorage`,
  // which covers reloads and same-origin routing, but a cross-origin page gets
  // a fresh store and would come back unthemed with design mode off while the
  // toolbar still shows it on.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    void browserDesignSet(tabId, true, palette).catch(() => {
      // Webview may be mid-navigation; the next url change re-asserts.
    });
  }, [tabId, pageUrl, enabled, palette]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      void browserDesignSet(tabId, next, palette).catch(() => {
        // Webview may be gone (tab closing); nothing to toggle.
      });
    },
    [tabId, palette],
  );

  const remove = useCallback((id: string) => {
    setChanges((current) => current.filter((change) => change.id !== id));
  }, []);

  const clear = useCallback(() => setChanges([]), []);

  return { enabled, changes, setEnabled, remove, clear };
}
