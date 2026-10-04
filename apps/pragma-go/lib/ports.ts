import type { OpenPort } from "@pragma/sdk";

/** Stable, worktree-scoped port rows for mobile navigation. */
export function portsForWorktree(ports: readonly OpenPort[], worktreeId: string): OpenPort[] {
  // Hermes does not yet provide Array.prototype.toSorted; `filter` already
  // returns a fresh array, so sorting it in place leaves `ports` untouched.
  // oxlint-disable-next-line unicorn/no-array-sort
  return ports
    .filter((port) => port.worktreeId === worktreeId)
    .sort((left, right) => left.port - right.port || left.tabId.localeCompare(right.tabId));
}
