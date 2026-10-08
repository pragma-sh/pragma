import type { OpenPort } from "@pragma-sh/sdk";

/** Stable, worktree-scoped port rows for mobile navigation. */
export function portsForWorktree(ports: readonly OpenPort[], worktreeId: string): OpenPort[] {
  const rows = ports.filter((port) => port.worktreeId === worktreeId);
  // Hermes does not yet provide Array.prototype.toSorted; `filter` already
  // returned a fresh array, so sorting it in place leaves `ports` untouched.
  // oxlint-disable-next-line unicorn/no-array-sort
  return rows.sort(
    (left, right) => left.port - right.port || left.tabId.localeCompare(right.tabId),
  );
}
