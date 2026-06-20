import { type ComponentType, type ReactNode, useMemo, useState } from "react";

import type { ChangedFile, ChangeStatus } from "@pragma/constants";
import { Icon } from "@iconify/react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fileIconId } from "@/lib/file-icons";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";

const STATUS_META: Record<ChangeStatus, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-400" },
  modified: { letter: "M", className: "text-amber-400" },
  deleted: { letter: "D", className: "text-red-400" },
  renamed: { letter: "R", className: "text-blue-400" },
  untracked: { letter: "?", className: "text-slate-400" },
};

/** A per-file icon-button action (stage, unstage, discard, …). */
export interface ChangeFileAction {
  /** Lucide icon component rendered inside the button. */
  icon: ComponentType<{ className?: string }>;
  /** Accessible label for the action on a specific file. */
  label: (file: ChangedFile) => string;
  /** Tooltip text. */
  title: string;
  onClick: (file: ChangedFile) => void;
}

/** A group-header icon-button action that operates on every file in the group. */
export interface ChangeGroupAction {
  /** Lucide icon component rendered inside the button. */
  icon: ComponentType<{ className?: string }>;
  /** Accessible label. */
  label: string;
  /** Tooltip text. */
  title: string;
  onClick: () => void;
}

/** Stable empty defaults so omitting the action props doesn't break memoization. */
const NO_FILE_ACTIONS: ChangeFileAction[] = [];
const NO_HEADER_ACTIONS: ChangeGroupAction[] = [];

/** Groups files by their parent directory, preserving first-seen order. */
function groupByDirectory(files: ChangedFile[]): Array<[string, ChangedFile[]]> {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const dir = dirname(file.path);
    const bucket = groups.get(dir);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(dir, [file]);
    }
  }
  return [...groups.entries()];
}

/**
 * One default-open collapsible change group (Staged, Unstaged, or Committed).
 * Files are flat-listed, grouped under a relative-directory label, and open a
 * read-only diff tab when clicked (the caller decides which diff side; the
 * Changes subtab opens the worktree-base diff for every list). `fileActions`
 * adds per-row icon buttons
 * (stage / unstage / discard) and `headerActions` adds matching group-wide icon
 * buttons to the header (shown only when the group is non-empty).
 */
export function ChangeGroup({
  title,
  files,
  emptyLabel,
  onOpen,
  fileActions = NO_FILE_ACTIONS,
  headerActions = NO_HEADER_ACTIONS,
  fileBadge,
}: {
  title: string;
  files: ChangedFile[];
  emptyLabel: string;
  onOpen: (file: ChangedFile) => void;
  fileActions?: ChangeFileAction[];
  headerActions?: ChangeGroupAction[];
  /** Optional trailing badge per row (e.g. a PR's unresolved-comment count). */
  fileBadge?: (file: ChangedFile) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const groups = useMemo(() => groupByDirectory(files), [files]);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="group/header flex w-full items-center hover:bg-white/5">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left text-xs text-slate-300">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-slate-500" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-slate-500" />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </CollapsibleTrigger>
        {files.length > 0 &&
          headerActions.map((action) => (
            <button
              aria-label={action.label}
              className="mr-1 shrink-0 rounded p-1 text-slate-500 opacity-0 hover:bg-white/10 hover:text-slate-200 focus-visible:opacity-100 group-hover/header:opacity-100"
              key={action.label}
              onClick={() => action.onClick()}
              title={action.title}
              type="button"
            >
              <action.icon className="size-3.5" />
            </button>
          ))}
        <span className="mr-2 shrink-0 rounded bg-white/10 px-1.5 text-[10px] text-slate-300">
          {files.length}
        </span>
      </div>
      <CollapsibleContent>
        {files.length === 0 ? (
          <p className="px-4 py-1 text-[11px] text-slate-600">{emptyLabel}</p>
        ) : (
          groups.map(([dir, items]) => (
            <div key={dir}>
              {dir && (
                <div className="px-3 py-0.5 text-[11px] uppercase tracking-wide text-slate-500">
                  {dir}
                </div>
              )}
              {items.map((file) => {
                const meta = STATUS_META[file.status];
                return (
                  <div
                    className="group/row flex w-full items-center gap-2 px-4 py-0.5 text-xs hover:bg-white/5"
                    key={`${file.path}:${file.status}`}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => onOpen(file)}
                      type="button"
                    >
                      <Icon className="size-4 shrink-0" icon={fileIconId(basename(file.path))} />
                      <span className="min-w-0 flex-1 truncate text-slate-200">
                        {basename(file.path)}
                      </span>
                    </button>
                    {fileActions.map((action) => (
                      <button
                        aria-label={action.label(file)}
                        className="shrink-0 rounded p-0.5 text-slate-500 opacity-0 hover:bg-white/10 hover:text-slate-200 focus-visible:opacity-100 group-hover/row:opacity-100"
                        key={action.title}
                        onClick={() => action.onClick(file)}
                        title={action.title}
                        type="button"
                      >
                        <action.icon className="size-3.5" />
                      </button>
                    ))}
                    {fileBadge?.(file)}
                    <span
                      aria-label={
                        file.additions === null
                          ? "Line count unavailable"
                          : `${file.additions} lines added`
                      }
                      className={cn(
                        "shrink-0 font-mono tabular-nums",
                        file.additions === null ? "text-slate-600" : "text-emerald-400",
                      )}
                    >
                      {file.additions === null ? "—" : `+${file.additions}`}
                    </span>
                    <span
                      aria-label={
                        file.deletions === null
                          ? "Line count unavailable"
                          : `${file.deletions} lines deleted`
                      }
                      className={cn(
                        "shrink-0 font-mono tabular-nums",
                        file.deletions === null ? "text-slate-600" : "text-red-400",
                      )}
                    >
                      {file.deletions === null ? "—" : `-${file.deletions}`}
                    </span>
                    <span className={cn("shrink-0 font-mono", meta.className)}>{meta.letter}</span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
