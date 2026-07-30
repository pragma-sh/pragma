import type { ReactNode } from "react";

/** Centered muted message shown while media is loading, missing, or refused. */
export function MediaStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
