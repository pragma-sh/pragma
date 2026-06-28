import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ModalShellProps {
  /** Card contents. */
  children: ReactNode;
  /** Override the card width / padding (defaults to `max-w-md`). */
  className?: string;
}

/**
 * Centered modal scaffold: a full-screen scrim with an elevated, hairline-bordered
 * card. Shared by the app's bespoke dialogs that aren't built on the Radix
 * `Dialog` primitive. Callers own open/close state and Escape handling (e.g.
 * `useEscapeToClose`) and render `ModalShell` only while open.
 */
export function ModalShell({ children, className }: ModalShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 supports-backdrop-filter:backdrop-blur-md">
      <div
        data-slot="modal-shell-card"
        className={cn(
          "bg-background w-full max-w-md rounded-xl border p-5 shadow-floating",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
