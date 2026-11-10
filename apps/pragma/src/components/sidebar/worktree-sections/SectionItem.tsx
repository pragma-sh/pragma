import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

/**
 * One clickable line in a section body. Its hover fill is a shade off the
 * row card's own background, like the row's agent lines.
 */
export const SectionItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  function SectionItem({ className, ...props }, ref) {
    return (
      <button
        className={cn(
          "-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        ref={ref}
        type="button"
        {...props}
      />
    );
  },
);
