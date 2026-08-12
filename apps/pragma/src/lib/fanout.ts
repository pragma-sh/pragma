import type { Fanout, FanoutMember, FanoutStatus, ScratchpadFile } from "@pragma/constants";

/** Fanout statuses that still occupy their parent worktree. */
const TERMINAL_STATUSES: ReadonlySet<FanoutStatus> = new Set<FanoutStatus>([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * True while a fanout still owns its parent. A completed, cancelled, or failed
 * fanout releases it and drops out of the active tree — it stays addressable by
 * its exact id.
 */
export function isActiveFanout(fanout: Fanout): boolean {
  return !TERMINAL_STATUSES.has(fanout.status);
}

/** The active fanout a worktree is the parent of, if any. */
export function fanoutForParent(fanouts: readonly Fanout[], worktreeId: string): Fanout | null {
  return (
    fanouts.find((fanout) => fanout.parentWorktreeId === worktreeId && isActiveFanout(fanout)) ??
    null
  );
}

/** The fanout and member a worktree is an attempt of, if any. */
export function memberForWorktree(
  fanouts: readonly Fanout[],
  worktreeId: string,
): { fanout: Fanout; member: FanoutMember } | null {
  for (const fanout of fanouts) {
    const member = fanout.members.find((candidate) => candidate.worktreeId === worktreeId);
    if (member) return { fanout, member };
  }
  return null;
}

/**
 * Worktree ids that belong to an active fanout as attempts.
 *
 * The sidebar renders these under their fanout group rather than as ordinary
 * children, so an attempt never reads as a hand-made worktree.
 */
export function attemptWorktreeIds(fanouts: readonly Fanout[]): Set<string> {
  const ids = new Set<string>();
  for (const fanout of fanouts) {
    if (!isActiveFanout(fanout)) continue;
    for (const member of fanout.members) {
      if (member.worktreeId) ids.add(member.worktreeId);
    }
  }
  return ids;
}

/** Members in stable creation order, so comparison columns never shuffle. */
export function orderedMembers(fanout: Fanout): FanoutMember[] {
  return fanout.members.toSorted((left, right) => left.ordinal - right.ordinal);
}

/**
 * A member's sidebar label: the harness and the model, never the generated
 * branch or worktree name — those carry no information a person chose.
 */
export function memberLabel(member: FanoutMember): string {
  const agent = member.catalogAgentId.split(".").at(-1) ?? member.catalogAgentId;
  return member.modelId ? `${agent} · ${member.modelId}` : agent;
}

/** Tooltip text for a member row: the full selector plus reasoning effort. */
export function memberTooltip(member: FanoutMember): string {
  const reasoning = member.reasoningId ?? "auto";
  return `${member.catalogAgentId}${member.modelId ? ` · ${member.modelId}` : ""} · reasoning ${reasoning}`;
}

/** One-word summary of a fanout for its sidebar group row. */
export function fanoutStatusLabel(fanout: Fanout): string {
  const total = fanout.members.length;
  const done = fanout.members.filter((member) => member.status === "done").length;
  switch (fanout.status) {
    case "provisioning":
      return "starting…";
    case "attention":
      return "needs input";
    case "partial":
      return "partly failed";
    case "ready":
      return "ready";
    case "needsResolution":
      return "needs resolution";
    case "cleanupFailed":
      return "cleanup failed";
    case "finalizing":
      return "finalizing…";
    case "interrupted":
      return "interrupted";
    default:
      return `${done}/${total} done`;
  }
}

/** One row of the comparison's scratchpad section. */
export interface ScratchpadRow {
  /** Stable row key: the shared path, or the normalized title when paths differ. */
  key: string;
  /** Row heading shown on the left. */
  title: string;
  /** The scratchpad each member contributed, or null where none matched. */
  byMember: Record<string, ScratchpadFile | null>;
}

/**
 * Pairs scratchpads across attempts: exact relative filename first, normalized
 * title second.
 *
 * A file only one attempt wrote gets its own row with empty cells elsewhere —
 * "this attempt documented something the others did not" is a comparison
 * result, not a rendering problem to hide.
 */
export function pairScratchpads(
  byMember: ReadonlyMap<string, readonly ScratchpadFile[]>,
): ScratchpadRow[] {
  const rows = new Map<string, ScratchpadRow>();
  const memberIds = [...byMember.keys()];
  const emptyCells = () => Object.fromEntries(memberIds.map((id) => [id, null]));

  const place = (memberId: string, key: string, title: string, file: ScratchpadFile) => {
    const row = rows.get(key) ?? { key, title, byMember: emptyCells() };
    // Two scratchpads from one attempt cannot share a cell; the second one
    // takes a row of its own keyed by its path.
    if (row.byMember[memberId]) {
      const fallbackKey = `${key}::${file.filePath}`;
      const fallback = rows.get(fallbackKey) ?? {
        key: fallbackKey,
        title,
        byMember: emptyCells(),
      };
      fallback.byMember[memberId] = file;
      rows.set(fallbackKey, fallback);
      return;
    }
    row.byMember[memberId] = file;
    rows.set(key, row);
  };

  // Pass one: exact path matches.
  const unmatched: Array<{ memberId: string; file: ScratchpadFile }> = [];
  const pathCounts = new Map<string, number>();
  for (const [memberId, files] of byMember) {
    for (const file of files) {
      pathCounts.set(file.filePath, (pathCounts.get(file.filePath) ?? 0) + 1);
      unmatched.push({ memberId, file });
    }
  }
  const remaining: typeof unmatched = [];
  for (const entry of unmatched) {
    if ((pathCounts.get(entry.file.filePath) ?? 0) > 1) {
      place(entry.memberId, entry.file.filePath, entry.file.title, entry.file);
    } else {
      remaining.push(entry);
    }
  }

  // Pass two: normalized titles, then anything still alone.
  const titleCounts = new Map<string, number>();
  for (const entry of remaining) {
    const key = normalizeTitle(entry.file.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  for (const entry of remaining) {
    const titleKey = normalizeTitle(entry.file.title);
    const key = (titleCounts.get(titleKey) ?? 0) > 1 ? `title:${titleKey}` : entry.file.filePath;
    place(entry.memberId, key, entry.file.title, entry.file);
  }

  return [...rows.values()].toSorted((left, right) => left.title.localeCompare(right.title));
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The union of paths any attempt changed, so every file gets one row even when
 * only one attempt touched it.
 */
export function unionChangedPaths(byMember: ReadonlyMap<string, readonly string[]>): string[] {
  const paths = new Set<string>();
  for (const list of byMember.values()) {
    for (const path of list) paths.add(path);
  }
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

/** Lower bound on a comparison column, in pixels. */
export const MIN_COLUMN_WIDTH = 320;

/**
 * Applies a header-separator drag to the shared column model.
 *
 * One model drives the sticky header and every section row: independent
 * resizable groups per row drift apart the moment a row is collapsed.
 */
export function resizeColumn(widths: readonly number[], index: number, deltaPx: number): number[] {
  return widths.map((width, position) =>
    position === index ? Math.max(MIN_COLUMN_WIDTH, width + deltaPx) : width,
  );
}
