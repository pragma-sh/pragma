import type { ReactNode } from "react";

/**
 * Platform-aware keyboard shortcut for docs prose: renders `<kbd>mac</kbd>` on
 * macOS and `<kbd>other</kbd>` on Linux/Windows. Both are server-rendered; the
 * docs layout sniffs the user agent into `data-platform` on `<html>` before
 * paint and CSS hides the wrong one, so this never hydrates. Without the
 * attribute (no JS) both variants stay visible.
 */
export function Keys({ mac, other }: { mac: ReactNode; other?: ReactNode }) {
  return (
    <>
      <kbd className="keys keys-mac">{mac}</kbd>
      {other == null ? null : <kbd className="keys keys-other">{other}</kbd>}
    </>
  );
}
