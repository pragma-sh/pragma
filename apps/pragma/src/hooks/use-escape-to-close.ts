import { useEffect } from "react";

/**
 * Closes a modal when the Escape key is pressed. Hand-rolled modals (those not
 * built on radix `Dialog`/`AlertDialog`, which already dismiss on Escape) use
 * this to match the OS convention. The listener is only active while `open` is
 * true, and calls `onClose` (not `onOpenChange(false)`) so each caller decides
 * its own close semantics.
 *
 * The listener uses capture phase and calls `preventDefault` so Escape doesn't
 * also bubble into terminal inputs or other handlers beneath the overlay.
 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);
}
