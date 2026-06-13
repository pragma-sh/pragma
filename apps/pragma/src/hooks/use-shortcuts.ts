import { useEffect, useRef } from "react";

import { hasWorkspaceModifier } from "@/lib/platform";

interface UseShortcutsOptions {
  projectCount: number;
  onProject: (index: number) => void;
  onNextTab: () => void;
  onPreviousTab: () => void;
}

/** Registers window-level project and tab shortcuts. */
export function useShortcuts(options: UseShortcutsOptions): void {
  // Callers pass a fresh `options` object every render; keep it in a ref so the
  // window listener is registered exactly once instead of churning on every
  // workspace state change.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!hasWorkspaceModifier(event)) {
        return;
      }
      const current = optionsRef.current;
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < current.projectCount) {
          event.preventDefault();
          current.onProject(index);
        }
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) {
          current.onPreviousTab();
        } else {
          current.onNextTab();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
