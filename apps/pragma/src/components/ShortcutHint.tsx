import { AnimatePresence, motion } from "motion/react";

import { motionTransition, tabItemVariants } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Animated key badge revealed while its configured navigation modifiers are held. */
export function ShortcutHint({ value, className }: { value: string | null; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {value ? (
        <motion.span
          aria-hidden
          animate="visible"
          className={cn(
            "relative inline-flex min-w-4 shrink-0 items-center justify-center rounded border border-border/80 bg-muted px-1 font-mono text-[10px] leading-4 text-foreground shadow-sm",
            className,
          )}
          exit="exit"
          initial="hidden"
          transition={motionTransition.fast}
          variants={tabItemVariants}
        >
          {value}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
