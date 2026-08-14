import { type ComponentType, type ReactNode, useMemo, useState } from "react";

import type { ChangedFile, ChangeStatus } from "@pragma/constants";
import { Icon } from "@iconify/react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { IconTooltip } from "@/components/ui/icon-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fileIconId } from "@/lib/file-icons";
import { basename, dirname } from "@/lib/path";
import { cn } from "@/lib/utils";

const STATUS_META: Record<ChangeStatus, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success" },
  modified: { letter: "M", className: "text-warning" },
  deleted: { letter: "D", className: "text-destructive" },
  renamed: { letter: "R", className: "text-primary" },
  untracked: { letter: "?", className: "text-muted-foreground" },
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
interface ChangeGroupProps {
  title: string;
  files: ChangedFile[];
  emptyLabel: string;
  onOpen: (file: ChangedFile) => void;
  fileActions?: ChangeFileAction[];
  headerActions?: ChangeGroupAction[];
  /** Optional trailing badge per row (e.g. a PR's unresolved-comment count). */
  fileBadge?: (file: ChangedFile) => ReactNode;
}

export function ChangeGroup({
  title,
  files,
  emptyLabel,
  onOpen,
  fileActions = NO_FILE_ACTIONS,
  headerActions = NO_HEADER_ACTIONS,
  fileBadge,
}: ChangeGroupProps) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="group/header flex w-full items-center hover:bg-muted">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left text-xs text-muted-foreground">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </CollapsibleTrigger>
        {files.length > 0 &&
          headerActions.map((action) => (
            <IconTooltip key={action.label} label={action.title}>
              <button
                aria-label={action.label}
                className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100"
                type="button"
                onClick={() => action.onClick()}
              >
                <action.icon className="size-3.5" />
              </button>
            </IconTooltip>
          ))}
        <span className="mr-2 shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {files.length}
        </span>
      </div>
      <CollapsibleContent>
        <ChangeFileList
          emptyLabel={emptyLabel}
          fileActions={fileActions}
          fileBadge={fileBadge}
          files={files}
          onOpen={onOpen}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Props for the flat, directory-grouped changed-file list. */
interface ChangeFileListProps {
  files: ChangedFile[];
  /** Shown when `files` is empty. */
  emptyLabel: string;
  onOpen: (file: ChangedFile) => void;
  fileActions?: ChangeFileAction[];
  /** Optional trailing badge per row (e.g. a PR's unresolved-comment count). */
  fileBadge?: (file: ChangedFile) => ReactNode;
}

/**
 * The directory-grouped changed-file rows a `ChangeGroup` renders, exported so
 * other collapsible containers (e.g. a per-commit file list) reuse the exact
 * same row style.
 */
export function ChangeFileList({
  files,
  emptyLabel,
  onOpen,
  fileActions = NO_FILE_ACTIONS,
  fileBadge,
}: ChangeFileListProps) {
  const groups = useMemo(() => groupByDirectory(files), [files]);
  if (files.length === 0) {
    return <p className="px-4 py-1 text-[11px] text-muted-foreground">{emptyLabel}</p>;
  }
  return groups.map(([dir, items]) => (
    <div key={dir}>
      {dir && (
        <div className="px-3 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {dir}
        </div>
      )}
      {items.map((file) => {
        const meta = STATUS_META[file.status];
        return (
          <div
            className="group/row flex w-full items-center gap-2 px-4 py-0.5 text-xs hover:bg-muted"
            key={`${file.path}:${file.status}`}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onOpen(file)}
              type="button"
            >
              <Icon className="size-4 shrink-0" icon={fileIconId(basename(file.path))} />
              <span className="min-w-0 flex-1 truncate text-foreground">{basename(file.path)}</span>
            </button>
            {fileActions.map((action) => (
              <IconTooltip key={action.title} label={action.title}>
                <button
                  aria-label={action.label(file)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                  type="button"
                  onClick={() => action.onClick(file)}
                >
                  <action.icon className="size-3.5" />
                </button>
              </IconTooltip>
            ))}
            {fileBadge?.(file)}
            <span
              aria-label={
                file.additions === null ? "Line count unavailable" : `${file.additions} lines added`
              }
              className={cn(
                "shrink-0 font-mono tabular-nums",
                file.additions === null ? "text-muted-foreground" : "text-success",
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
                file.deletions === null ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {file.deletions === null ? "—" : `-${file.deletions}`}
            </span>
            <span className={cn("shrink-0 font-mono", meta.className)}>{meta.letter}</span>
          </div>
        );
      })}
    </div>
  ));
}
