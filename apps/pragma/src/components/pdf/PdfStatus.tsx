import type { ReactNode } from "react";

/** Centered muted message shown while a PDF is loading, missing, or refused. */
export function PdfStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
