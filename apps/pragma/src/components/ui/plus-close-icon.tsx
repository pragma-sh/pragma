import { motion } from "motion/react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { motionTransition } from "@/lib/motion";

/**
 * A "+" that rotates into an "×" while its menu is open — a plus turned 45° is
 * exactly a close glyph, so one icon covers both states with no swap.
 *
 * Shared by every add-style menu trigger (the sidebar's add-project/worktree
 * menu, the tab strip's new-tab menu) so the affordance reads identically
 * wherever it appears.
 */
export function PlusCloseIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <motion.span
      animate={{ rotate: open ? 45 : 0 }}
      className={cn("inline-flex", className)}
      initial={false}
      transition={motionTransition.base}
    >
      <Plus />
    </motion.span>
  );
}
