import type { ReactNode } from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import { modalVariants, scrimVariants } from "@/lib/motion";

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
 * `useEscapeToClose`).
 *
 * Callers must render it inside an `<AnimatePresence>` and toggle it with a
 * conditional child rather than an early `return null`, or the close animation
 * has no frames to play in. The card grows in and shrinks further out, matching
 * `components/ui/dialog.tsx` so both dialog families move the same way.
 */
export function ModalShell({ children, className }: ModalShellProps) {
  return (
    <motion.div
      animate="visible"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 supports-backdrop-filter:backdrop-blur-md"
      exit="exit"
      initial="hidden"
      variants={scrimVariants}
    >
      <motion.div
        data-slot="modal-shell-card"
        className={cn(
          "bg-background w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border p-5 shadow-floating",
          className,
        )}
        layout="size"
        variants={modalVariants}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
