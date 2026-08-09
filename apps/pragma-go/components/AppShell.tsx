import type { ReactNode } from "react";

/** Native shell; iPad navigation remains owned by NativeTabs. */
export function AppShell({ children }: { children: ReactNode }) {
  return children;
}
