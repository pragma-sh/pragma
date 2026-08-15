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
          // A fixed height keeps every row the same size whether or not its
          // hover-revealed `size-6` actions (pin, new-child, delete) are
          // showing, so hovering one row never nudges the rows below it.
          "group flex h-8 items-center gap-1 rounded-lg px-2 text-sm",
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
        </button>
        {trailing}
        {/* The status slot is last and fixed-width, so dots land on the same
            column on every row no matter how many trailing indicators a row
            carries — and the label truncates against it instead of under it. */}
        <span className="flex w-2 shrink-0 items-center justify-center">{status}</span>
      </div>
    );
  },
);
