import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Portrait device shell for the Pragma Go section, so the phone client is not
 * shown in the same 16:9 frame as every desktop recording.
 */
export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[15rem]", className)}>
      <div className="border-border bg-card shadow-floating relative rounded-[2rem] border p-2">
        <span
          aria-hidden
          className="bg-border absolute top-3.5 left-1/2 h-1 w-14 -translate-x-1/2 rounded-full"
        />
        <div className="overflow-hidden rounded-[1.5rem]">{children}</div>
      </div>
    </div>
  );
}
