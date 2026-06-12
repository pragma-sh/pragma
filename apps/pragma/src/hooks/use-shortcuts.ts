import { useEffect, useRef } from "react";
import { isMac, modifierLabel } from "@/lib/platform";

interface ShortcutHandlers {
  onProjectDigit: (index: number) => void;
  onNextTab: () => void;
  onPrevTab: () => void;
}

export function useWorkspaceShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = isMac ? e.ctrlKey : e.altKey;
      const h = ref.current;

      if (mod && e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          h.onPrevTab();
        } else {
          h.onNextTab();
        }
        return;
      }

      if (mod && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        h.onProjectDigit(Number.parseInt(e.key, 10) - 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

export { modifierLabel };
