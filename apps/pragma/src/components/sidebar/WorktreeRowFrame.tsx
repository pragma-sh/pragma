import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Class for a worktree row's container, highlighting the selected one. */
function worktreeRowClass(selected: boolean): string {
  return selected
    ? "bg-sidebar-accent text-sidebar-accent-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-accent/70";
}

interface WorktreeRowFrameProps extends ComponentPropsWithoutRef<"div"> {
  depth: number;
  selected: boolean;
  disabled?: boolean;
  caret: ReactNode;
  onActivate: () => void;
  onDoubleActivate?: () => void;
  icon: ReactNode;
  label: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
}

/**
 * The shared visual shell for a sidebar worktree row: an indented container
 * with a caret slot, a clickable primary area (icon + label + status dot), and
 * a trailing slot for indicators and actions. Used by both ordinary worktree
 * rows and fanout attempt rows so the two read identically.
 */
export const WorktreeRowFrame = forwardRef<HTMLDivElement, WorktreeRowFrameProps>(
  function WorktreeRowFrame(
    {
      depth,
      selected,
      disabled,
      caret,
      onActivate,
      onDoubleActivate,
      icon,
      label,
      status,
      trailing,
      className,
      style,
      ...props
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm",
          worktreeRowClass(selected),
          className,
        )}
        style={{ ...style, paddingLeft: 8 + depth * 14 }}
        {...props}
      >
        {caret}
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
          disabled={disabled}
          type="button"
          onClick={onActivate}
          onDoubleClick={onDoubleActivate}
        >
          {icon}
          {label}
          {status}
        </button>
        {trailing}
      </div>
    );
  },
);
