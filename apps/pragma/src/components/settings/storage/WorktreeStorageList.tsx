import { AlertCircle, Loader2 } from "lucide-react";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { formatBytes } from "@/lib/binary-file";

import { worktreeLabel, type ScanState, type StorageTarget } from "./storage-model";

/**
 * Every worktree in scope with its size. Rows are ordered by size once
 * scanned, pending rows last.
 */
export function WorktreeStorageList({
  targets,
  states,
  showProject,
}: {
  targets: readonly StorageTarget[];
  states: Readonly<Record<string, ScanState>>;
  showProject: boolean;
}) {
  const sizeOf = (target: StorageTarget) => {
    const state = states[target.worktree.id];
    return state?.status === "done" ? state.storage.totalBytes : -1;
  };
  const rows = targets.toSorted((a, b) => sizeOf(b) - sizeOf(a));
  const largest = Math.max(1, ...rows.map(sizeOf));

  return (
    <SettingsCard title="Worktrees" description="Size of each worktree on disk.">
      <ul className="divide-y rounded-lg border">
        {rows.map((target) => (
          <WorktreeRow
            key={target.worktree.id}
            largest={largest}
            showProject={showProject}
            state={states[target.worktree.id]}
            target={target}
          />
        ))}
      </ul>
    </SettingsCard>
  );
}

function WorktreeRow({
  target,
  state,
  largest,
  showProject,
}: {
  target: StorageTarget;
  state: ScanState | undefined;
  largest: number;
  showProject: boolean;
}) {
  const storage = state?.status === "done" ? state.storage : null;
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {showProject ? (
            <span className="text-muted-foreground">{target.project.name} / </span>
          ) : null}
          {worktreeLabel(target.worktree)}
        </p>
        {storage ? (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(storage.totalBytes / largest) * 100}%` }}
            />
          </div>
        ) : null}
      </div>
      <RowStatus state={state} />
    </li>
  );
}

function RowStatus({ state }: { state: ScanState | undefined }) {
  if (state?.status === "done") {
    return (
      <span className="shrink-0 text-sm tabular-nums">
        {formatBytes(state.storage.totalBytes)}
        {state.storage.truncated ? "+" : ""}
      </span>
    );
  }
  if (state?.status === "error") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
        <AlertCircle className="size-3.5" /> {state.error}
      </span>
    );
  }
  return (
    <Loader2 aria-label="Scanning" className="size-4 shrink-0 animate-spin text-muted-foreground" />
  );
}
