import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Small keyboard-key badge used in host and plugin UI. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
