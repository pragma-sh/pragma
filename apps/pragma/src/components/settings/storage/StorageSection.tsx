import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { StorageReminderSettings } from "@pragma-sh/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/binary-file";
import type { ConfigScope } from "@/lib/tauri";

import { FreeUpSpaceCard } from "./FreeUpSpaceCard";
import { StorageReminderCard } from "./StorageReminderCard";
import { StorageTreemap } from "./StorageTreemap";
import { WorktreeStorageList } from "./WorktreeStorageList";
import {
  buildStorageTree,
  storageTotals,
  type ScanState,
  type StorageTarget,
  type StorageTotals,
} from "./storage-model";
import { useStorageScan, useStorageTargets } from "./use-storage-scan";

const NO_TARGETS: readonly StorageTarget[] = [];

/**
 * Settings → Storage. Global scope measures every project and draws them as
 * boxes; project scope draws the current project's worktrees. Scans run only
 * while this section is mounted.
 */
export function StorageSection({
  scope,
  projectId,
  projectName,
  reminder,
  persistReminder,
}: {
  scope: ConfigScope;
  projectId: string | null;
  projectName: string | null;
  /** Null outside global scope, where the reminder is not configurable. */
  reminder: StorageReminderSettings | null;
  persistReminder: (patch: StorageReminderSettings) => Promise<void>;
}) {
  const global = scope === "global";
  const { targets, error } = useStorageTargets(scope, projectId);
  const { states, rescan, deleteFolder } = useStorageScan(targets);
  const list = targets ?? NO_TARGETS;
  const nodes = useMemo(() => buildStorageTree(list, states, global), [list, states, global]);

  return (
    <div className="space-y-5">
      <StorageSummary
        error={error}
        global={global}
        projectName={projectName}
        rescan={rescan}
        states={states}
        targets={targets}
      />

      <SettingsCard
        title={global ? "Projects" : "Worktrees"}
        description="Every file is a tile whose area is its share of the disk, colored by the folder it lives in."
      >
        <StorageTreemap
          nodes={nodes}
          rootLabel={global ? "All projects" : (projectName ?? "Project")}
        />
      </SettingsCard>

      <FreeUpSpaceCard
        deleteFolder={deleteFolder}
        showProject={global}
        states={states}
        targets={list}
      />

      <WorktreeStorageList showProject={global} states={states} targets={list} />

      {reminder ? <StorageReminderCard persist={persistReminder} settings={reminder} /> : null}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "2 projects · 5 worktrees · 3 GB reclaimable". */
function summaryLine(
  list: readonly StorageTarget[],
  totals: StorageTotals,
  global: boolean,
): string {
  const parts = [plural(list.length, "worktree")];
  if (global)
    parts.unshift(plural(new Set(list.map((target) => target.project.id)).size, "project"));
  if (totals.reclaimableBytes > 0)
    parts.push(`${formatBytes(totals.reclaimableBytes)} reclaimable`);
  if (totals.failed > 0) parts.push(`${totals.failed} could not be scanned`);
  return parts.join(" · ");
}

/** The headline total, what it covers, and scan progress. */
function StorageSummary({
  targets,
  states,
  global,
  projectName,
  error,
  rescan,
}: {
  targets: readonly StorageTarget[] | null;
  states: Readonly<Record<string, ScanState>>;
  global: boolean;
  projectName: string | null;
  error: string | null;
  rescan: () => void;
}) {
  const list = targets ?? NO_TARGETS;
  const totals = storageTotals(list, states);
  const settled = totals.scanned + totals.failed;
  const scanning = targets === null || settled < list.length;
  return (
    <SettingsCard
      title="Storage"
      description={
        global
          ? "Disk used by every project Pragma manages, including each worktree."
          : `Disk used by ${projectName ?? "this project"} and its worktrees.`
      }
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <StorageHeadline global={global} list={list} totals={totals} />
        <Button disabled={scanning} size="sm" variant="outline" onClick={rescan}>
          <RefreshCw className={scanning ? "animate-spin" : undefined} /> Rescan
        </Button>
      </div>
      {scanning ? (
        <ScanProgress settled={settled} total={targets === null ? null : list.length} />
      ) : null}
    </SettingsCard>
  );
}

/** The big total (a trailing `+` when a scan stopped early) and its breakdown. */
function StorageHeadline({
  list,
  totals,
  global,
}: {
  list: readonly StorageTarget[];
  totals: StorageTotals;
  global: boolean;
}) {
  return (
    <div>
      <p className="text-3xl font-semibold tabular-nums">
        {formatBytes(totals.totalBytes)}
        {totals.truncated ? "+" : ""}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{summaryLine(list, totals, global)}</p>
    </div>
  );
}

/** How many worktrees have answered; `total` is null until the list loads. */
function ScanProgress({ settled, total }: { settled: number; total: number | null }) {
  return (
    <div className="mt-4 space-y-1.5">
      <Progress value={total ? (settled / total) * 100 : 0} />
      <p className="text-xs text-muted-foreground">
        Scanned {settled} of {total ?? "…"} worktrees
      </p>
    </div>
  );
}
