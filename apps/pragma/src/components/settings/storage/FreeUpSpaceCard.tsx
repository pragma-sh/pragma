import { useState } from "react";
import { FolderX, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StorageFolder } from "@pragma-sh/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { formatBytes } from "@/lib/binary-file";
import { errorMessage } from "@/lib/errors";

import { worktreeLabel, type ScanState, type StorageTarget } from "./storage-model";

/** One deletable folder with the worktree it lives in. */
interface Candidate {
  target: StorageTarget;
  folder: StorageFolder;
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.target.worktree.id}:${candidate.folder.path}`;
}

/** What a pending confirmation will delete. */
type Pending = { kind: "one"; candidate: Candidate } | { kind: "all"; candidates: Candidate[] };

/**
 * Lists the gitignored folders every finished scan found — build output,
 * dependency trees, caches — largest first, and deletes them one at a time or
 * all together. The host re-checks each folder is still gitignored and
 * unprotected before removing it, so a stale list cannot delete tracked work.
 */
export function FreeUpSpaceCard({
  targets,
  states,
  showProject,
  deleteFolder,
}: {
  targets: readonly StorageTarget[];
  states: Readonly<Record<string, ScanState>>;
  showProject: boolean;
  deleteFolder: (worktreeId: string, path: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const candidates: Candidate[] = targets
    .flatMap((target) => {
      const state = states[target.worktree.id];
      return state?.status === "done"
        ? state.storage.ignoredFolders.map((folder) => ({ target, folder }))
        : [];
    })
    .toSorted((a, b) => b.folder.bytes - a.folder.bytes);
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.folder.bytes, 0);

  const remove = async (toDelete: readonly Candidate[]) => {
    const keys = toDelete.map(candidateKey);
    setBusy((current) => new Set([...current, ...keys]));
    let freed = 0;
    const failures: string[] = [];
    // One at a time: each is a large recursive delete on the same disk.
    for (const candidate of toDelete) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose, see above.
        await deleteFolder(candidate.target.worktree.id, candidate.folder.path);
        freed += candidate.folder.bytes;
      } catch (cause) {
        failures.push(`${candidate.folder.path}: ${errorMessage(cause)}`);
      }
    }
    setBusy((current) => new Set([...current].filter((key) => !keys.includes(key))));
    if (freed > 0) toast.success(`Freed ${formatBytes(freed)}`);
    if (failures.length > 0) toast.error(failures.join("\n"));
  };

  return (
    <SettingsCard
      title="Free up space"
      description="Gitignored folders such as dependencies, build output, and caches. Tools recreate them when needed, so they are usually safe to delete."
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No large gitignored folders found yet.</p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-medium tabular-nums">{formatBytes(totalBytes)}</span>{" "}
              <span className="text-muted-foreground">
                in {candidates.length} folder{candidates.length === 1 ? "" : "s"}
              </span>
            </p>
            <Button
              disabled={busy.size > 0}
              size="sm"
              variant="destructive"
              onClick={() => setPending({ kind: "all", candidates })}
            >
              <Trash2 /> Delete all
            </Button>
          </div>
          <ul className="divide-y rounded-lg border">
            {candidates.map((candidate) => {
              const key = candidateKey(candidate);
              return (
                <li key={key} className="flex items-center gap-3 px-3 py-2">
                  <FolderX className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{candidate.folder.path}/</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {showProject ? `${candidate.target.project.name} · ` : ""}
                      {worktreeLabel(candidate.target.worktree)} ·{" "}
                      {candidate.folder.fileCount.toLocaleString()} files
                    </p>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums">
                    {formatBytes(candidate.folder.bytes)}
                  </span>
                  <IconButton
                    aria-label={`Delete ${candidate.folder.path}`}
                    disabled={busy.has(key)}
                    label="Delete"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setPending({ kind: "one", candidate })}
                  >
                    <Trash2 />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "all"
                ? `Delete ${pending.candidates.length} folders?`
                : `Delete ${pending?.candidate.folder.path}/?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "all"
                ? `This permanently removes ${formatBytes(totalBytes)} of gitignored files across ${new Set(pending.candidates.map((candidate) => candidate.target.worktree.id)).size} worktrees.`
                : pending
                  ? `This permanently removes ${formatBytes(pending.candidate.folder.bytes)} from ${worktreeLabel(pending.candidate.target.worktree)}.`
                  : null}{" "}
              Reinstall dependencies or rebuild to get them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pending) return;
                void remove(pending.kind === "all" ? pending.candidates : [pending.candidate]);
                setPending(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
